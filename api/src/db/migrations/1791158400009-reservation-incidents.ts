import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Incidents staff report when a guest checks out (damage, missing items,
 * overstay, noise, smoking or other violations), each with an optional extra
 * charge. The charges are totalled on the reservation so its balance and
 * payment status include them without re-reading every incident.
 */
export class ReservationIncidents1791158400009 implements MigrationInterface {
  name = "ReservationIncidents1791158400009";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE reservations ADD COLUMN extra_charges_kobo bigint NOT NULL DEFAULT 0 CHECK (extra_charges_kobo >= 0)`);
    await queryRunner.query(`
      CREATE TABLE reservation_incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id uuid NOT NULL REFERENCES properties(id),
        reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
        category text NOT NULL CHECK (category IN ('broken_items','missing_items','overstay','noise','smoking','other')),
        description text CHECK (description IS NULL OR length(description) BETWEEN 1 AND 2000),
        charge_kobo bigint NOT NULL DEFAULT 0 CHECK (charge_kobo >= 0),
        created_by uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX reservation_incidents_reservation_idx ON reservation_incidents(reservation_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE reservation_incidents`);
    await queryRunner.query(`ALTER TABLE reservations DROP COLUMN extra_charges_kobo`);
  }
}
