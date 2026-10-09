import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A guest's government-issued ID, recorded by staff against a booking. Photos
 * of the card are optional and kept in PostgreSQL (never the public photo
 * bucket), served only to signed-in staff.
 */
export class GuestIdentityDocuments1791158400008 implements MigrationInterface {
  name = "GuestIdentityDocuments1791158400008";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE guest_identity_documents (
        guest_id uuid PRIMARY KEY REFERENCES guests(id) ON DELETE CASCADE,
        id_type text NOT NULL CHECK (id_type IN ('passport','national_id','voters_card','drivers_license','other')),
        id_number text NOT NULL CHECK (length(id_number) BETWEEN 1 AND 64),
        updated_by uuid REFERENCES users(id),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE guest_identity_images (
        guest_id uuid NOT NULL REFERENCES guest_identity_documents(guest_id) ON DELETE CASCADE,
        side text NOT NULL CHECK (side IN ('front','back')),
        content_type text NOT NULL,
        byte_size int NOT NULL CHECK (byte_size > 0),
        sha256 text NOT NULL,
        data bytea NOT NULL,
        created_by uuid REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (guest_id, side)
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE guest_identity_images`);
    await queryRunner.query(`DROP TABLE guest_identity_documents`);
  }
}
