import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Transactional email outbox. Messages are queued in the same transaction as
 * the change they describe and delivered afterwards by the email dispatcher, so
 * a rolled-back change never emails anyone and a committed one is never lost.
 * Payloads (guest details, temporary passwords in `sealed_payload`) are cleared
 * once a message reaches a final state; the row stays as the delivery log.
 */
export class CreateEmailMessages1791158400004 implements MigrationInterface {
  name = "CreateEmailMessages1791158400004";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE email_messages (
        id uuid PRIMARY KEY,
        property_id uuid NOT NULL REFERENCES properties(id),
        template text NOT NULL,
        audience text NOT NULL CHECK (audience IN ('guest', 'staff', 'management')),
        recipient_email text NOT NULL,
        recipient_name text,
        recipient_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        subject text,
        payload jsonb,
        sealed_payload text CHECK (sealed_payload IS NULL OR sealed_payload LIKE 'v1.%'),
        dedupe_key text,
        status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
        attempts int NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        locked_until timestamptz,
        provider_message_id text,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz,
        UNIQUE (property_id, dedupe_key)
      )`);
    await queryRunner.query(`CREATE INDEX email_messages_due_idx ON email_messages (next_attempt_at) WHERE status IN ('queued', 'sending')`);
    await queryRunner.query(`CREATE INDEX email_messages_log_idx ON email_messages (property_id, created_at DESC, id DESC)`);
    await queryRunner.query(`
      INSERT INTO settings(key, value, is_secret) VALUES
        ('email.provider', 'none', false),
        ('email.resend_api_key', NULL, true),
        ('email.from_address', NULL, false),
        ('email.reply_to', NULL, false),
        ('email.guest_notifications', 'on', false),
        ('email.staff_notifications', 'on', false),
        ('email.management_alerts', 'on', false)
      ON CONFLICT (key) DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM settings WHERE key LIKE 'email.%'`);
    await queryRunner.query(`DROP TABLE IF EXISTS email_messages`);
  }
}
