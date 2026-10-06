import { randomUUID } from "node:crypto";
import type { Sql } from "../../db/sql.js";
import { ROLES, hasPermission, type Permission, type Role } from "../../lib/permissions.js";
import { seal } from "../../lib/secret-box.js";
import { TEMPLATE_AUDIENCE, type TemplateData, type TemplateName } from "./templates.js";

/**
 * Queues emails inside the caller's transaction (the transactional outbox):
 * they commit or roll back with the change they describe, and the dispatcher
 * delivers them afterwards. Queueing never calls the network, and it happens
 * whether or not email is switched on; the dispatcher decides what to send.
 */

export type Recipient = { email: string; name: string | null; userId?: string | null };

/** Values that must not sit in the outbox in plain text (temporary passwords), sealed with the settings key. */
export type SealedValues = { key: Buffer; values: Record<string, string> };

export type QueueInput<K extends TemplateName> = {
  propertyId: string;
  template: K;
  to: Recipient;
  data: TemplateData[K];
  /** Makes queueing idempotent per property; a repeat with the same key is ignored. */
  dedupeKey?: string;
  sealed?: SealedValues;
};

const ADDRESS = /^[^\s<>@",;]+@[^\s<>@",;]+\.[^\s<>@",;]+$/;

/** Associated data binding a sealed payload to its message row. */
export const sealedPayloadContext = (messageId: string) => `email:${messageId}`;

export async function queueEmail<K extends TemplateName>(tx: Sql, input: QueueInput<K>): Promise<boolean> {
  const email = input.to.email.trim();
  if (!ADDRESS.test(email)) return false;
  const id = randomUUID();
  const sealed = input.sealed && Object.keys(input.sealed.values).length > 0 ? seal(input.sealed.key, JSON.stringify(input.sealed.values), sealedPayloadContext(id)) : null;
  const inserted = await tx.exec(
    // clock_timestamp(), unlike now(), advances within a transaction, so emails queued together keep their order.
    `INSERT INTO email_messages(id, property_id, template, audience, recipient_email, recipient_name, recipient_user_id, payload, sealed_payload, dedupe_key,
                                created_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, clock_timestamp(), clock_timestamp())
     ON CONFLICT (property_id, dedupe_key) DO NOTHING`,
    [
      id,
      input.propertyId,
      input.template,
      TEMPLATE_AUDIENCE[input.template],
      email,
      input.to.name,
      input.to.userId ?? null,
      JSON.stringify(input.data),
      sealed,
      input.dedupeKey ?? null,
    ],
  );
  return inserted > 0;
}

export type AlertInput<K extends TemplateName> = {
  propertyId: string;
  template: K;
  data: TemplateData[K];
  /** Everyone active whose role holds this permission… */
  permission?: Permission;
  /** …or exactly these roles. */
  roles?: readonly Role[];
  /** Per-recipient dedupe: the user id is appended. */
  dedupeKey?: string;
};

/** Queues one personal copy of an alert for each active staff member in the target roles. */
export async function queueAlert<K extends TemplateName>(tx: Sql, input: AlertInput<K>): Promise<number> {
  const roles = input.roles ?? (input.permission ? ROLES.filter((role) => hasPermission(role, input.permission as Permission)) : []);
  if (roles.length === 0) return 0;
  const users = await tx.rows<{ id: string; email: string; full_name: string }>(
    `SELECT id, email, full_name FROM users WHERE property_id = $1 AND active AND role = ANY($2::text[]) ORDER BY created_at, id`,
    [input.propertyId, roles],
  );
  let queued = 0;
  for (const user of users) {
    const created = await queueEmail(tx, {
      propertyId: input.propertyId,
      template: input.template,
      to: { email: user.email, name: user.full_name, userId: user.id },
      data: input.data,
      dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${user.id}` : undefined,
    });
    if (created) queued += 1;
  }
  return queued;
}
