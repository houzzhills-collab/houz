import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Apartment photos can live in object storage (Cloudflare R2). A row then holds
 * the object key instead of the bytes. Rows stored in PostgreSQL (when R2 is
 * not configured, and any uploaded before it was) keep working unchanged.
 */
export class ApartmentImagesObjectStorage1791158400006 implements MigrationInterface {
  name = "ApartmentImagesObjectStorage1791158400006";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE apartment_images ADD COLUMN storage_key text UNIQUE, ALTER COLUMN data DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE apartment_images ADD CONSTRAINT apartment_images_has_content CHECK ((data IS NULL) <> (storage_key IS NULL))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // Photos that exist only in R2 cannot be brought back into the table; refuse rather than lose them.
    const [row] = (await queryRunner.query(`SELECT count(*)::int AS count FROM apartment_images WHERE data IS NULL`)) as Array<{ count: number }>;
    if ((row?.count ?? 0) > 0) throw new Error(`${row?.count} apartment photos are stored only in R2; copy them back before reverting this migration`);
    await queryRunner.query(`ALTER TABLE apartment_images DROP CONSTRAINT apartment_images_has_content, DROP COLUMN storage_key, ALTER COLUMN data SET NOT NULL`);
  }
}
