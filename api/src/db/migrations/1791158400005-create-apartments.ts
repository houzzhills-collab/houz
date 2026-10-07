import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Shortlet apartment listings. Each apartment is backed by exactly one row in
 * `rooms`, which stays the bookable unit: availability, the overlap exclusion
 * constraint, holds, checkout, payments and housekeeping state all keep working
 * through it. The room carries the nightly rate, guest capacity and the
 * booking name (`room_type` = the apartment's name); everything a guest reads
 * about the apartment lives here.
 *
 * Images are stored in the database (bytea) so the API needs no object store;
 * each is capped at 8 MB and served with long-lived cache headers.
 */
export class CreateApartments1791158400005 implements MigrationInterface {
  name = "CreateApartments1791158400005";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE apartments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        property_id uuid NOT NULL REFERENCES properties(id),
        room_id uuid NOT NULL UNIQUE REFERENCES rooms(id),
        slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        name text NOT NULL,
        category text NOT NULL,
        summary text,
        description text,
        status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
        address_line text,
        area text,
        city text NOT NULL,
        state text NOT NULL,
        country text NOT NULL DEFAULT 'Nigeria',
        latitude numeric(9,6) CHECK (latitude BETWEEN -90 AND 90),
        longitude numeric(9,6) CHECK (longitude BETWEEN -180 AND 180),
        directions text,
        bedrooms int NOT NULL DEFAULT 1 CHECK (bedrooms >= 0),
        bathrooms int NOT NULL DEFAULT 1 CHECK (bathrooms >= 0),
        beds int NOT NULL DEFAULT 1 CHECK (beds >= 0),
        size_sqm numeric(8,2) CHECK (size_sqm > 0),
        caution_fee_kobo bigint NOT NULL DEFAULT 0 CHECK (caution_fee_kobo >= 0),
        minimum_nights int NOT NULL DEFAULT 1 CHECK (minimum_nights >= 1),
        check_in_time text NOT NULL DEFAULT '14:00' CHECK (check_in_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
        check_out_time text NOT NULL DEFAULT '12:00' CHECK (check_out_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
        amenities text[] NOT NULL DEFAULT '{}',
        features text[] NOT NULL DEFAULT '{}',
        facilities text[] NOT NULL DEFAULT '{}',
        house_rules text[] NOT NULL DEFAULT '{}',
        warranty_policy text,
        cancellation_policy text,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (property_id, slug),
        CHECK ((latitude IS NULL) = (longitude IS NULL))
      )`);
    await queryRunner.query(`CREATE INDEX apartments_list_idx ON apartments (property_id, status, name, id)`);
    await queryRunner.query(`CREATE INDEX apartments_city_idx ON apartments (property_id, lower(city)) WHERE status = 'published'`);

    await queryRunner.query(`
      CREATE TABLE apartment_images (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        apartment_id uuid NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
        content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
        byte_size int NOT NULL CHECK (byte_size > 0 AND byte_size <= 8388608),
        sha256 text NOT NULL,
        data bytea NOT NULL,
        caption text,
        position int NOT NULL DEFAULT 0,
        is_cover boolean NOT NULL DEFAULT false,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (apartment_id, sha256)
      )`);
    await queryRunner.query(`CREATE INDEX apartment_images_order_idx ON apartment_images (apartment_id, position, created_at)`);
    await queryRunner.query(`CREATE UNIQUE INDEX apartment_images_one_cover ON apartment_images (apartment_id) WHERE is_cover`);
    // The booking tracker reads stays per unit by date.
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS reservations_room_dates_idx ON reservations (room_id, check_in, check_out)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS reservations_room_dates_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS apartment_images`);
    await queryRunner.query(`DROP TABLE IF EXISTS apartments`);
  }
}
