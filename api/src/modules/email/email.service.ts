import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { DataSource } from "typeorm";
import type { AppConfig } from "../../config/env.js";
import { withConnection, withTransaction } from "../../db/sql.js";
import { AppError, Errors } from "../../lib/errors.js";
import { open } from "../../lib/secret-box.js";
import type { Principal } from "../auth/session.service.js";
import type { GlobalSettings } from "../settings/settings.registry.js";
import type { SettingsService } from "../settings/settings.service.js";
import { sealedPayloadContext } from "./queue.js";
import { EmailSendError, sendWithResend } from "./resend.js";
import { isTemplateName, renderTemplate, type Audience, type TemplateContext } from "./templates.js";

type ClaimedRow = {
  id: string;
  property_id: string;
  property_name: string;
  template: string;
  audience: Audience;
  recipient_email: string;
  recipient_name: string | null;
  payload: Record<string, unknown> | null;
  sealed_payload: string | null;
  attempts: number;
  created_at: Date;
};

export type DispatchReport = { sent: number; retrying: number; failed: number; skipped: number };

export type EmailLogEntry = {
  id: string;
  template: string;
  audience: string;
  recipient: string;
  subject: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  sentAt: Date | null;
};

const BATCH = 10;
const POLL_INTERVAL_MS = 3_000;
/** A claimed message is retaken by another worker if not finished within this lease. */
const LEASE_SECONDS = 180;
const MAX_ATTEMPTS = 8;
/** Undelivered messages older than this are dropped rather than sent late (e.g. after email was off for days). */
const MAX_AGE_HOURS = 48;
/** Resend's default limit is 2 requests per second per team. */
const MIN_SEND_GAP_MS = 550;
/** Security notices reach owners even when management alerts are switched off, and guests always get the codes they ask for. */
const ALWAYS_SEND = new Set(["alert.settings_changed", "guest.access_code"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 30 s, 1 min, 2 min … capped at 1 hour. */
function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 3_600);
}

/**
 * Delivers queued emails through Resend. Any number of API replicas can run the
 * dispatcher: messages are claimed with FOR UPDATE SKIP LOCKED under a lease,
 * and each message id doubles as Resend's Idempotency-Key, so a crash or a
 * lease takeover never sends an email twice.
 */
export class EmailService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastSendAt = 0;

  constructor(
    private readonly db: DataSource,
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Starts the background dispatcher (API server only; jobs and tests drive `dispatchDue` directly). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
    this.log.info("email dispatcher started");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  private tick(): void {
    if (this.running) return;
    this.running = (async () => {
      try {
        // Keep draining while full batches come back, so a burst goes out promptly.
        for (let round = 0; round < 10 && this.timer; round += 1) {
          const report = await this.dispatchDue();
          if (report.sent + report.retrying + report.failed + report.skipped < BATCH) break;
        }
      } catch (error) {
        this.log.warn({ err: error }, "email dispatch failed");
      } finally {
        this.running = null;
      }
    })();
  }

  /** Sends one batch of due messages. Safe to call concurrently from several processes. */
  async dispatchDue(limit = BATCH): Promise<DispatchReport> {
    const report: DispatchReport = { sent: 0, retrying: 0, failed: 0, skipped: 0 };
    const settings = await this.settings.current();
    const email = settings.email;
    if (email.provider !== "resend" || !email.resendApiKey || !email.from) {
      report.skipped = await withTransaction(this.db, (tx) =>
        tx.exec(
          `UPDATE email_messages SET status = 'skipped', last_error = 'Email delivery is turned off', payload = NULL, sealed_payload = NULL, locked_until = NULL
            WHERE id IN (SELECT id FROM email_messages
                          WHERE status = 'queued' OR (status = 'sending' AND locked_until < now())
                          LIMIT 500 FOR UPDATE SKIP LOCKED)`,
        ),
      );
      return report;
    }

    const claimed = await withTransaction(this.db, (tx) =>
      tx.rows<ClaimedRow>(
        `UPDATE email_messages m
            SET status = 'sending', attempts = m.attempts + 1, locked_until = now() + make_interval(secs => $2)
           FROM properties p
          WHERE p.id = m.property_id
            AND m.id IN (SELECT id FROM email_messages
                          WHERE (status = 'queued' AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
                          ORDER BY next_attempt_at
                          LIMIT $1
                          FOR UPDATE SKIP LOCKED)
          RETURNING m.id, m.property_id, p.name AS property_name, m.template, m.audience, m.recipient_email, m.recipient_name,
                    m.payload, m.sealed_payload, m.attempts, m.created_at`,
        [limit, LEASE_SECONDS],
      ),
    );

    // UPDATE … RETURNING does not keep the subquery's order; send in the order things happened.
    claimed.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    for (const row of claimed) {
      const outcome = await this.deliver(row, settings);
      report[outcome] += 1;
    }
    if (claimed.length > 0) this.log.info({ ...report }, "email batch processed");
    return report;
  }

  private skipReason(row: ClaimedRow, email: GlobalSettings["email"]): string | null {
    if (Date.now() - row.created_at.getTime() > MAX_AGE_HOURS * 3_600_000) return `Not sent within ${MAX_AGE_HOURS} hours`;
    if (ALWAYS_SEND.has(row.template)) return null;
    if (row.audience === "guest" && !email.guestNotifications) return "Guest emails are turned off";
    if (row.audience === "staff" && !email.staffNotifications) return "Staff account emails are turned off";
    if (row.audience === "management" && !email.managementAlerts) return "Management alerts are turned off";
    return null;
  }

  private async deliver(row: ClaimedRow, settings: GlobalSettings): Promise<keyof DispatchReport> {
    const email = settings.email;
    const skip = this.skipReason(row, email);
    if (skip) {
      await this.finish(row.id, "skipped", { error: skip });
      return "skipped";
    }
    if (!isTemplateName(row.template) || !row.payload) {
      await this.finish(row.id, "failed", { error: `Unknown template ${row.template}` });
      return "failed";
    }

    let data: Record<string, unknown> = row.payload;
    if (row.sealed_payload) {
      const opened = open(this.config.settingsEncryptionKey, row.sealed_payload, sealedPayloadContext(row.id));
      if (opened === null) {
        await this.finish(row.id, "failed", { error: "Sealed content cannot be decrypted; check SETTINGS_ENCRYPTION_KEY" });
        return "failed";
      }
      data = { ...data, ...(JSON.parse(opened) as Record<string, unknown>) };
    }

    let subject: string | null = null;
    try {
      const rendered = renderTemplate(row.template, data, this.context(row.property_name, row.recipient_name, row.audience));
      subject = rendered.subject;
      await this.pace();
      const sent = await sendWithResend(
        { baseUrl: this.config.email.resendBaseUrl, apiKey: email.resendApiKey ?? "", timeoutMs: this.config.email.timeoutMs },
        { from: email.from ?? "", to: row.recipient_email, replyTo: email.replyTo, subject: rendered.subject, html: rendered.html, text: rendered.text, tags: { template: row.template, audience: row.audience } },
        row.id,
      );
      await this.finish(row.id, "sent", { subject, providerMessageId: sent.id });
      return "sent";
    } catch (error) {
      const message = error instanceof EmailSendError ? error.message : "Rendering failed";
      if (!(error instanceof EmailSendError)) this.log.error({ err: error, messageId: row.id, template: row.template }, "email rendering failed");
      const retryable = error instanceof EmailSendError && error.retryable && row.attempts < MAX_ATTEMPTS;
      if (retryable) {
        await withConnection(this.db, (sql) =>
          sql.exec(
            `UPDATE email_messages SET status = 'queued', subject = coalesce($4, subject), last_error = $2, locked_until = NULL,
                    next_attempt_at = now() + make_interval(secs => $3)
              WHERE id = $1 AND status = 'sending'`,
            [row.id, message, backoffSeconds(row.attempts), subject],
          ),
        );
        this.log.warn({ messageId: row.id, template: row.template, attempts: row.attempts, error: message }, "email send failed; will retry");
        return "retrying";
      }
      await this.finish(row.id, "failed", { subject, error: message });
      this.log.error({ messageId: row.id, template: row.template, attempts: row.attempts, error: message }, "email permanently failed");
      return "failed";
    }
  }

  /** Records a final state and drops the payload: the row remains only as a delivery log. */
  private async finish(id: string, status: "sent" | "failed" | "skipped", details: { subject?: string | null; providerMessageId?: string; error?: string }): Promise<void> {
    await withConnection(this.db, (sql) =>
      sql.exec(
        `UPDATE email_messages
            SET status = $2, subject = coalesce($3, subject), provider_message_id = $4, last_error = $5,
                sent_at = CASE WHEN $2 = 'sent' THEN now() END, payload = NULL, sealed_payload = NULL, locked_until = NULL
          WHERE id = $1`,
        [id, status, details.subject ?? null, details.providerMessageId ?? null, details.error ?? null],
      ),
    );
  }

  private async pace(): Promise<void> {
    const wait = this.lastSendAt + MIN_SEND_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastSendAt = Date.now();
  }

  private context(propertyName: string, recipientName: string | null, audience: string): TemplateContext {
    const web = this.config.payments.publicWebUrl;
    return {
      // Guests see the hospitality brand; staff see the workspace's own logo line.
      brand: { propertyName, webUrl: web, tagline: audience === "guest" ? "Serviced apartments" : "Property operations" },
      recipientName,
      managementUrl: web ? `${web}/management` : null,
      bookingUrl: web ? `${web}/` : null,
      statusUrl: (reference) => (web ? `${web}/payment-result?reference=${encodeURIComponent(reference)}` : null),
      myBookingsUrl: web ? `${web}/bookings` : null,
    };
  }

  /**
   * Sends a test email to the signed-in owner straight away, using the saved
   * key and sender even while delivery is still switched off, so the owner can
   * check the setup before turning email on.
   */
  async sendTest(principal: Principal): Promise<{ to: string; providerMessageId: string }> {
    const { email } = await this.settings.current();
    if (!email.resendApiKey || !email.from) throw Errors.conflict("Save the Resend API key and sender address first", "EMAIL_NOT_CONFIGURED");
    const property = await withConnection(this.db, (sql) => sql.one<{ name: string }>(`SELECT name FROM properties WHERE id = $1`, [principal.propertyId]));
    const rendered = renderTemplate("system.test", { requestedBy: principal.fullName }, this.context(property.name, principal.fullName, "management"));
    const id = randomUUID();
    try {
      await this.pace();
      const sent = await sendWithResend(
        { baseUrl: this.config.email.resendBaseUrl, apiKey: email.resendApiKey, timeoutMs: this.config.email.timeoutMs },
        { from: email.from, to: principal.email, replyTo: email.replyTo, subject: rendered.subject, html: rendered.html, text: rendered.text, tags: { template: "system.test", audience: "management" } },
        id,
      );
      await this.logDirect(id, principal, rendered.subject, "sent", sent.id, null);
      return { to: principal.email, providerMessageId: sent.id };
    } catch (error) {
      if (!(error instanceof EmailSendError)) throw error;
      await this.logDirect(id, principal, rendered.subject, "failed", null, error.message);
      throw error.retryable ? new AppError(502, "EMAIL_PROVIDER_UNAVAILABLE", error.message) : Errors.unprocessable(error.message, "EMAIL_REJECTED");
    }
  }

  private async logDirect(id: string, principal: Principal, subject: string, status: "sent" | "failed", providerMessageId: string | null, error: string | null): Promise<void> {
    await withConnection(this.db, (sql) =>
      sql.exec(
        `INSERT INTO email_messages(id, property_id, template, audience, recipient_email, recipient_name, recipient_user_id, subject, status,
                                    attempts, provider_message_id, last_error, sent_at)
         VALUES ($1, $2, 'system.test', 'management', $3, $4, $5, $6, $7, 1, $8, $9, CASE WHEN $7 = 'sent' THEN now() END)`,
        [id, principal.propertyId, principal.email, principal.fullName, principal.userId, subject, status, providerMessageId, error],
      ),
    );
  }

  /** The delivery log for the owner, newest first. */
  async recent(propertyId: string, filters: { status?: string; limit: number }): Promise<{ messages: EmailLogEntry[]; counts: Record<string, number> }> {
    return withConnection(this.db, async (sql) => {
      const messages = await sql.rows<EmailLogEntry>(
        `SELECT id, template, audience, recipient_email AS recipient, subject, status, attempts, last_error AS "lastError",
                created_at AS "createdAt", sent_at AS "sentAt"
           FROM email_messages
          WHERE property_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC, id DESC
          LIMIT $3`,
        [propertyId, filters.status ?? null, filters.limit],
      );
      const rows = await sql.rows<{ status: string; count: number }>(
        `SELECT status, count(*)::int AS count FROM email_messages
          WHERE property_id = $1 AND (status IN ('queued', 'sending') OR created_at > now() - interval '7 days')
          GROUP BY status`,
        [propertyId],
      );
      const counts: Record<string, number> = { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
      for (const row of rows) counts[row.status] = row.count;
      return { messages, counts };
    });
  }
}
