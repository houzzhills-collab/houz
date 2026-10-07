import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * "Book now, pay later" for website bookings. A pay-later booking holds its
 * room for the configured window without starting checkout, so it has no
 * payment row to carry the request's idempotency key; the reservation carries
 * it instead. Guests find their bookings by email, so that lookup is indexed.
 */
export class PayLaterBookings1791158400007 implements MigrationInterface {
  name = "PayLaterBookings1791158400007";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE reservations
        ADD COLUMN pay_later boolean NOT NULL DEFAULT false,
        ADD COLUMN idempotency_key text,
        ADD COLUMN request_fingerprint text`);
    await queryRunner.query(`CREATE UNIQUE INDEX reservations_idempotency_key_unique ON reservations(property_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX guests_email_lower_idx ON guests(property_id, lower(email)) WHERE email IS NOT NULL`);
    await queryRunner.query(`INSERT INTO settings(key, value, is_secret) VALUES ('booking.pay_later_hours', '24', false) ON CONFLICT (key) DO NOTHING`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM settings WHERE key = 'booking.pay_later_hours'`);
    await queryRunner.query(`DROP INDEX IF EXISTS guests_email_lower_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS reservations_idempotency_key_unique`);
    await queryRunner.query(`ALTER TABLE reservations DROP COLUMN request_fingerprint, DROP COLUMN idempotency_key, DROP COLUMN pay_later`);
  }
}
