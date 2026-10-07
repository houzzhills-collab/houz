import { createHash, randomUUID } from "node:crypto";
import type { Static } from "typebox";
import type { FastifyInstance } from "fastify";
import { isSqlState, withConnection, withTransaction, type Sql } from "../../db/sql.js";
import { BUSINESS_TIMEZONE } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import type { Role } from "../../lib/permissions.js";
import type { Principal } from "../auth/session.service.js";
import type { ApartmentStatus, CreateApartmentBody, UpdateApartmentBody } from "./apartments.schemas.js";
import { IMAGE_CACHE_CONTROL, MAX_IMAGES_PER_APARTMENT, MAX_IMAGE_BYTES, detectImageType, imageUrl, imageUrls, objectKey, type ImageType, type ImageUrls } from "./images.js";

/**
 * Shortlet apartments. Each apartment owns one `rooms` row, kept in sync here,
 * which is what reservations book: room_number = unit code, room_type = the
 * apartment's name (so the public booking flow books this exact apartment),
 * nightly rate and capacity. The room is sellable only while the apartment is
 * published.
 */

type CreateInput = Static<typeof CreateApartmentBody>;
type UpdateInput = Static<typeof UpdateApartmentBody>;

const TODAY = `(now() AT TIME ZONE '${BUSINESS_TIMEZONE}')::date`;

type StayJson = { reference: string; guestName: string | null; checkIn: string; checkOut: string; status: string };
type ImageJson = { id: string; caption: string | null; position: number; isCover: boolean; contentType: string; byteSize: number; storageKey: string | null };

export type ApartmentRow = {
  id: string;
  room_id: string;
  slug: string;
  name: string;
  unit_code: string;
  category: string;
  summary: string | null;
  description: string | null;
  status: ApartmentStatus;
  address_line: string | null;
  area: string | null;
  city: string;
  state: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  directions: string | null;
  bedrooms: number;
  bathrooms: number;
  beds: number;
  size_sqm: number | null;
  caution_fee_kobo: string;
  minimum_nights: number;
  check_in_time: string;
  check_out_time: string;
  amenities: string[];
  features: string[];
  facilities: string[];
  house_rules: string[];
  warranty_policy: string | null;
  cancellation_policy: string | null;
  nightly_rate_kobo: string;
  max_guests: number;
  unit_status: string;
  images: ImageJson[];
  current_stay: StayJson | null;
  next_arrival: StayJson | null;
  created_at: Date;
  updated_at: Date;
};

/** Every apartment read, with its unit, photos and current/next stay. Filter with `WHERE` on alias `a`. */
export const APARTMENT_SELECT = `
  SELECT a.id, a.room_id, a.slug, a.name, ro.room_number AS unit_code, a.category, a.summary, a.description, a.status,
         a.address_line, a.area, a.city, a.state, a.country, a.latitude::float8 AS latitude, a.longitude::float8 AS longitude, a.directions,
         a.bedrooms, a.bathrooms, a.beds, a.size_sqm::float8 AS size_sqm, a.caution_fee_kobo::text, a.minimum_nights,
         a.check_in_time, a.check_out_time, a.amenities, a.features, a.facilities, a.house_rules, a.warranty_policy, a.cancellation_policy,
         ro.nightly_rate_kobo::text, ro.capacity AS max_guests, ro.status AS unit_status, a.created_at, a.updated_at,
         coalesce((SELECT json_agg(json_build_object('id', i.id, 'caption', i.caption, 'position', i.position, 'isCover', i.is_cover,
                                                     'contentType', i.content_type, 'byteSize', i.byte_size, 'storageKey', i.storage_key)
                                   ORDER BY i.position, i.created_at, i.id)
                     FROM apartment_images i WHERE i.apartment_id = a.id), '[]'::json) AS images,
         cur.stay AS current_stay, nxt.stay AS next_arrival
    FROM apartments a
    JOIN rooms ro ON ro.id = a.room_id
    LEFT JOIN LATERAL (
      SELECT json_build_object('reference', r.reference, 'guestName', g.full_name, 'checkIn', r.check_in::text, 'checkOut', r.check_out::text, 'status', r.status) AS stay
        FROM reservations r JOIN guests g ON g.id = r.guest_id
       WHERE r.room_id = a.room_id AND r.status IN ('confirmed', 'checked_in') AND r.check_in <= ${TODAY} AND r.check_out > ${TODAY}
       ORDER BY (r.status = 'checked_in') DESC, r.created_at DESC
       LIMIT 1) cur ON true
    LEFT JOIN LATERAL (
      SELECT json_build_object('reference', r.reference, 'guestName', g.full_name, 'checkIn', r.check_in::text, 'checkOut', r.check_out::text, 'status', r.status) AS stay
        FROM reservations r JOIN guests g ON g.id = r.guest_id
       WHERE r.room_id = a.room_id AND r.check_in > ${TODAY}
         AND (r.status = 'confirmed' OR (r.status = 'pending_payment' AND r.hold_expires_at > now()))
       ORDER BY r.check_in, r.created_at
       LIMIT 1) nxt ON true`;

export function toApartmentView(row: ApartmentRow, role: Role, urls: ImageUrls) {
  // Housekeeping works the units but sees no prices or guests, as in the rooms module.
  const restricted = role === "housekeeping";
  const stay = (value: StayJson | null) => (value && restricted ? { ...value, guestName: null } : value);
  return {
    id: row.id,
    roomId: row.room_id,
    slug: row.slug,
    name: row.name,
    unitCode: row.unit_code,
    category: row.category,
    summary: row.summary,
    description: row.description,
    status: row.status,
    location: {
      addressLine: row.address_line,
      area: row.area,
      city: row.city,
      state: row.state,
      country: row.country,
      latitude: row.latitude,
      longitude: row.longitude,
      directions: row.directions,
    },
    pricing: { nightlyRateKobo: restricted ? null : row.nightly_rate_kobo, cautionFeeKobo: restricted ? null : row.caution_fee_kobo, currency: "NGN" as const },
    capacity: { maxGuests: row.max_guests, bedrooms: row.bedrooms, bathrooms: row.bathrooms, beds: row.beds, sizeSqm: row.size_sqm },
    stayRules: { minimumNights: row.minimum_nights, checkInTime: row.check_in_time, checkOutTime: row.check_out_time },
    amenities: row.amenities,
    features: row.features,
    facilities: row.facilities,
    houseRules: row.house_rules,
    policies: { warranty: row.warranty_policy, cancellation: row.cancellation_policy },
    images: row.images.map((image) => ({
      id: image.id,
      url: imageUrl(urls, row.id, image),
      caption: image.caption,
      position: image.position,
      isCover: image.isCover,
      contentType: image.contentType,
      byteSize: image.byteSize,
    })),
    unitStatus: row.unit_status,
    currentStay: stay(row.current_stay),
    nextArrival: stay(row.next_arrival),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---- Normalisation ----

/** Trims, drops blanks and case-insensitive duplicates, keeps the author's order. */
export function normaliseLabels(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const label = value.trim().replace(/\s+/g, " ");
    const key = label.toLowerCase();
    if (label && !seen.has(key)) {
      seen.add(key);
      out.push(label);
    }
  }
  return out;
}

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return slug.length >= 2 ? slug : `apartment-${slug}`.replace(/-+$/g, "");
}

/** Optional text: undefined keeps, null or blank clears, otherwise trimmed. */
function textChange(value: string | null | undefined, current: string | null): string | null {
  if (value === undefined) return current;
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw Errors.unprocessable(`${label} cannot be blank`, "VALIDATION_FAILED");
  return trimmed;
}

async function uniqueSlug(tx: Sql, propertyId: string, base: string, exceptId: string | null): Promise<string> {
  const taken = new Set(
    (
      await tx.rows<{ slug: string }>(`SELECT slug FROM apartments WHERE property_id = $1 AND (slug = $2 OR slug LIKE $2 || '-%') AND id IS DISTINCT FROM $3`, [
        propertyId,
        base,
        exceptId,
      ])
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The name is how bookings select the unit (room_type), so it must not match any other unit's. */
async function assertNameFree(tx: Sql, propertyId: string, name: string, exceptRoomId: string | null): Promise<void> {
  const clash = await tx.maybeOne(`SELECT 1 FROM rooms WHERE property_id = $1 AND lower(room_type) = lower($2) AND id IS DISTINCT FROM $3 LIMIT 1`, [propertyId, name, exceptRoomId]);
  if (clash) throw Errors.conflict("Another apartment or room type already uses this name", "NAME_TAKEN");
}

function translateUniqueViolation(error: unknown): never {
  if (isSqlState(error, "23505")) {
    const constraint = (error as { driverError?: { constraint?: string } }).driverError?.constraint ?? "";
    if (constraint.includes("slug")) throw Errors.conflict("Another apartment already uses this slug", "SLUG_TAKEN");
    throw Errors.conflict("Another unit already uses this unit code", "UNIT_CODE_TAKEN");
  }
  throw error;
}

// ---- Reads ----

export async function loadApartment(sql: Sql, propertyId: string, id: string): Promise<ApartmentRow> {
  const row = await sql.maybeOne<ApartmentRow>(`${APARTMENT_SELECT} WHERE a.id = $1 AND a.property_id = $2`, [id, propertyId]);
  if (!row) throw Errors.notFound("Apartment not found");
  return row;
}

function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export async function listApartments(
  app: FastifyInstance,
  principal: Principal,
  filters: { status?: ApartmentStatus; city?: string; q?: string; limit: number; cursor?: string },
) {
  const cursor = decodeCursor(filters.cursor, 2);
  const rows = await withConnection(app.db, (sql) =>
    sql.rows<ApartmentRow>(
      `${APARTMENT_SELECT}
        WHERE a.property_id = $1
          AND ($2::text IS NULL OR a.status = $2) AND ($2::text IS NOT NULL OR a.status <> 'archived')
          AND ($3::text IS NULL OR lower(a.city) = lower($3))
          AND ($4::text IS NULL OR a.name ILIKE $4 ESCAPE '\\' OR ro.room_number ILIKE $4 ESCAPE '\\' OR a.category ILIKE $4 ESCAPE '\\' OR a.area ILIKE $4 ESCAPE '\\')
          AND ($5::text IS NULL OR (a.name, a.id) > ($5::text, $6::uuid))
        ORDER BY a.name, a.id
        LIMIT $7`,
      [principal.propertyId, filters.status ?? null, filters.city?.trim() ? filters.city.trim() : null, filters.q?.trim() ? likePattern(filters.q) : null, cursor?.[0] ?? null, cursor?.[1] ?? null, filters.limit + 1],
    ),
  );
  const page = toPage(rows, filters.limit, (row) => [row.name, row.id]);
  return { apartments: page.items.map((row) => toApartmentView(row, principal.role, imageUrls(app.config))), nextCursor: page.nextCursor };
}

// ---- Writes ----

export async function createApartment(app: FastifyInstance, principal: Principal, input: CreateInput) {
  const name = required(input.name, "Name");
  const unitCode = required(input.unitCode, "Unit code");
  const category = required(input.category, "Category");
  const city = required(input.location.city, "City");
  const state = required(input.location.state, "State");
  if ((input.location.latitude === undefined) !== (input.location.longitude === undefined)) {
    throw Errors.unprocessable("Send latitude and longitude together", "VALIDATION_FAILED");
  }
  try {
    return await withTransaction(app.db, async (tx) => {
      await assertNameFree(tx, principal.propertyId, name, null);
      const slug = input.slug ?? await uniqueSlug(tx, principal.propertyId, slugify(name), null);
      const room = await tx.one<{ id: string }>(
        `INSERT INTO rooms(property_id, room_number, room_type, nightly_rate_kobo, capacity, active) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [principal.propertyId, unitCode, name, input.nightlyRateKobo, input.maxGuests],
      );
      const created = await tx.one<{ id: string }>(
        `INSERT INTO apartments(property_id, room_id, slug, name, category, summary, description, address_line, area, city, state, country,
                                latitude, longitude, directions, bedrooms, bathrooms, beds, size_sqm, caution_fee_kobo, minimum_nights,
                                check_in_time, check_out_time, amenities, features, facilities, house_rules, warranty_policy, cancellation_policy,
                                created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                 $24::text[], $25::text[], $26::text[], $27::text[], $28, $29, $30, $30)
         RETURNING id`,
        [
          principal.propertyId,
          room.id,
          slug,
          name,
          category,
          textChange(input.summary, null),
          textChange(input.description, null),
          textChange(input.location.addressLine, null),
          textChange(input.location.area, null),
          city,
          state,
          textChange(input.location.country, null) ?? "Nigeria",
          input.location.latitude ?? null,
          input.location.longitude ?? null,
          textChange(input.location.directions, null),
          input.bedrooms ?? 1,
          input.bathrooms ?? 1,
          input.beds ?? 1,
          input.sizeSqm ?? null,
          input.cautionFeeKobo ?? 0,
          input.minimumNights ?? 1,
          input.checkInTime ?? "14:00",
          input.checkOutTime ?? "12:00",
          normaliseLabels(input.amenities) ?? [],
          normaliseLabels(input.features) ?? [],
          normaliseLabels(input.facilities) ?? [],
          normaliseLabels(input.houseRules) ?? [],
          textChange(input.warrantyPolicy, null),
          textChange(input.cancellationPolicy, null),
          principal.userId,
        ],
      );
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "apartment.created",
        entityType: "apartment",
        entityId: created.id,
        details: { name, unitCode, roomId: room.id, nightlyRateKobo: input.nightlyRateKobo },
        outbox: { reference: name },
      });
      return toApartmentView(await loadApartment(tx, principal.propertyId, created.id), principal.role, imageUrls(app.config));
    });
  } catch (error) {
    translateUniqueViolation(error);
  }
}

type LockedApartment = ApartmentRow & { image_count: number };

async function lockApartment(tx: Sql, propertyId: string, id: string): Promise<LockedApartment> {
  const locked = await tx.maybeOne<{ id: string }>(`SELECT id FROM apartments WHERE id = $1 AND property_id = $2 FOR UPDATE`, [id, propertyId]);
  if (!locked) throw Errors.notFound("Apartment not found");
  const row = await loadApartment(tx, propertyId, id);
  return { ...row, image_count: row.images.length };
}

/** Bookings that still need the unit: anything not yet checked out and not ended. */
async function upcomingBookings(tx: Sql, roomId: string): Promise<number> {
  const row = await tx.one<{ count: number }>(
    `SELECT count(*)::int AS count FROM reservations
      WHERE room_id = $1 AND check_out > ${TODAY}
        AND (status IN ('confirmed', 'checked_in') OR (status = 'pending_payment' AND hold_expires_at > now()))`,
    [roomId],
  );
  return row.count;
}

export async function updateApartment(app: FastifyInstance, principal: Principal, id: string, input: UpdateInput) {
  try {
    return await withTransaction(app.db, async (tx) => {
      const current = await lockApartment(tx, principal.propertyId, id);
      const name = input.name === undefined ? current.name : required(input.name, "Name");
      const unitCode = input.unitCode === undefined ? current.unit_code : required(input.unitCode, "Unit code");
      const status = input.status ?? current.status;
      const location = input.location ?? {};
      const latitude = location.latitude === undefined ? current.latitude : location.latitude;
      const longitude = location.longitude === undefined ? current.longitude : location.longitude;
      if ((latitude === null) !== (longitude === null)) throw Errors.unprocessable("Send latitude and longitude together", "VALIDATION_FAILED");

      if (name !== current.name) await assertNameFree(tx, principal.propertyId, name, current.room_id);
      if (status === "published" && current.status !== "published" && current.image_count === 0) {
        throw Errors.conflict("Add at least one photo before publishing", "PHOTOS_REQUIRED");
      }
      if (status === "archived" && current.status !== "archived") {
        const upcoming = await upcomingBookings(tx, current.room_id);
        if (upcoming > 0) throw Errors.conflict(`This apartment has ${upcoming} upcoming booking${upcoming === 1 ? "" : "s"}. Cancel or complete them first.`, "APARTMENT_HAS_BOOKINGS");
      }

      await tx.exec(
        `UPDATE rooms SET room_number = $2, room_type = $3, nightly_rate_kobo = $4, capacity = $5, active = $6 WHERE id = $1`,
        [current.room_id, unitCode, name, input.nightlyRateKobo ?? current.nightly_rate_kobo, input.maxGuests ?? current.max_guests, status === "published"],
      );
      await tx.exec(
        `UPDATE apartments SET slug = $2, name = $3, category = $4, summary = $5, description = $6, status = $7, address_line = $8, area = $9,
                city = $10, state = $11, country = $12, latitude = $13, longitude = $14, directions = $15, bedrooms = $16, bathrooms = $17,
                beds = $18, size_sqm = $19, caution_fee_kobo = $20, minimum_nights = $21, check_in_time = $22, check_out_time = $23,
                amenities = $24::text[], features = $25::text[], facilities = $26::text[], house_rules = $27::text[], warranty_policy = $28,
                cancellation_policy = $29, updated_by = $30, updated_at = now()
          WHERE id = $1`,
        [
          id,
          input.slug ?? current.slug,
          name,
          input.category === undefined ? current.category : required(input.category, "Category"),
          textChange(input.summary, current.summary),
          textChange(input.description, current.description),
          status,
          textChange(location.addressLine, current.address_line),
          textChange(location.area, current.area),
          location.city === undefined ? current.city : required(location.city, "City"),
          location.state === undefined ? current.state : required(location.state, "State"),
          location.country === undefined ? current.country : required(location.country, "Country"),
          latitude,
          longitude,
          textChange(location.directions, current.directions),
          input.bedrooms ?? current.bedrooms,
          input.bathrooms ?? current.bathrooms,
          input.beds ?? current.beds,
          input.sizeSqm === undefined ? current.size_sqm : input.sizeSqm,
          input.cautionFeeKobo ?? current.caution_fee_kobo,
          input.minimumNights ?? current.minimum_nights,
          input.checkInTime ?? current.check_in_time,
          input.checkOutTime ?? current.check_out_time,
          normaliseLabels(input.amenities) ?? current.amenities,
          normaliseLabels(input.features) ?? current.features,
          normaliseLabels(input.facilities) ?? current.facilities,
          normaliseLabels(input.houseRules) ?? current.house_rules,
          textChange(input.warrantyPolicy, current.warranty_policy),
          textChange(input.cancellationPolicy, current.cancellation_policy),
          principal.userId,
        ],
      );
      const action = status !== current.status ? `apartment.${status}` : "apartment.updated";
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action,
        entityType: "apartment",
        entityId: id,
        details: { fields: Object.keys(input), from: current.status, to: status, ...(input.nightlyRateKobo !== undefined ? { nightlyRateKobo: input.nightlyRateKobo } : {}) },
        outbox: { type: "apartment.updated", reference: name },
      });
      return toApartmentView(await loadApartment(tx, principal.propertyId, id), principal.role, imageUrls(app.config));
    });
  } catch (error) {
    translateUniqueViolation(error);
  }
}

// ---- Photos ----

export type UploadedFile = { data: Buffer; caption: string | null };

type PreparedImage = UploadedFile & { id: string; contentType: ImageType; sha256: string; storageKey: string | null };

/**
 * Adds photos. With R2, the bytes are uploaded before the database transaction
 * so no row lock is held across the network; anything uploaded but not
 * recorded (a concurrent duplicate, or a failed transaction) is deleted again.
 */
export async function addImages(app: FastifyInstance, principal: Principal, id: string, files: readonly UploadedFile[]) {
  if (files.length === 0) throw Errors.unprocessable("Attach at least one photo as a `file` part", "NO_FILES");
  const storage = app.storage;
  const all: PreparedImage[] = files.map((file, index) => {
    const contentType = detectImageType(file.data);
    if (!contentType) throw Errors.unprocessable(`File ${index + 1} is not a JPEG, PNG or WebP image`, "UNSUPPORTED_IMAGE");
    if (file.data.length > MAX_IMAGE_BYTES) throw Errors.unprocessable(`File ${index + 1} is larger than 8 MB`, "IMAGE_TOO_LARGE");
    const imageId = randomUUID();
    return { ...file, id: imageId, contentType, sha256: createHash("sha256").update(file.data).digest("hex"), storageKey: storage ? objectKey(id, imageId, contentType) : null };
  });
  const unique = all.filter((file, index) => all.findIndex((other) => other.sha256 === file.sha256) === index);

  // Check before uploading anything, so a doomed request never touches the bucket.
  const known = await withConnection(app.db, async (sql) => {
    await loadApartment(sql, principal.propertyId, id);
    return sql.rows<{ sha256: string }>(`SELECT sha256 FROM apartment_images WHERE apartment_id = $1`, [id]);
  });
  const candidates = unique.filter((file) => !known.some((row) => row.sha256 === file.sha256));
  assertRoomForPhotos(known.length, candidates.length);

  const uploaded: PreparedImage[] = [];
  const discard = async (images: readonly PreparedImage[]) => {
    for (const image of images) {
      if (!storage || !image.storageKey) continue;
      await storage.delete(image.storageKey).catch((error: unknown) => app.log.warn({ err: error, key: image.storageKey }, "could not delete unused photo from R2"));
    }
  };
  try {
    if (storage) {
      for (const file of candidates) {
        await storage.put(file.storageKey ?? "", file.data, file.contentType, IMAGE_CACHE_CONTROL);
        uploaded.push(file);
      }
    }
    const result = await withTransaction(app.db, async (tx) => {
      const current = await lockApartment(tx, principal.propertyId, id);
      // Re-check under the lock: another upload may have added the same photos meanwhile.
      const present = new Set((await tx.rows<{ sha256: string }>(`SELECT sha256 FROM apartment_images WHERE apartment_id = $1`, [id])).map((row) => row.sha256));
      const toInsert = candidates.filter((file) => !present.has(file.sha256));
      assertRoomForPhotos(current.image_count, toInsert.length);
      const nextPosition = current.images.reduce((max, image) => Math.max(max, image.position + 1), 0);
      const hasCover = current.images.some((image) => image.isCover);
      for (const [index, file] of toInsert.entries()) {
        await tx.exec(
          `INSERT INTO apartment_images(id, apartment_id, content_type, byte_size, sha256, data, storage_key, caption, position, is_cover, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [file.id, id, file.contentType, file.data.length, file.sha256, file.storageKey ? null : file.data, file.storageKey, file.caption, nextPosition + index, !hasCover && index === 0, principal.userId],
        );
      }
      if (toInsert.length > 0) {
        await recordEvent(tx, {
          propertyId: principal.propertyId,
          actorId: principal.userId,
          action: "apartment.images_added",
          entityType: "apartment",
          entityId: id,
          details: { count: toInsert.length, storage: storage ? "r2" : "database" },
          outbox: { type: "apartment.updated", reference: current.name },
        });
      }
      return {
        inserted: new Set(toInsert.map((file) => file.id)),
        response: {
          uploaded: toInsert.length,
          duplicates: files.length - toInsert.length,
          apartment: toApartmentView(await loadApartment(tx, principal.propertyId, id), principal.role, imageUrls(app.config)),
        },
      };
    });
    await discard(uploaded.filter((file) => !result.inserted.has(file.id)));
    return result.response;
  } catch (error) {
    await discard(uploaded);
    throw error;
  }
}

function assertRoomForPhotos(existing: number, adding: number): void {
  if (existing + adding > MAX_IMAGES_PER_APARTMENT) {
    throw Errors.conflict(`An apartment can have at most ${MAX_IMAGES_PER_APARTMENT} photos (it has ${existing})`, "TOO_MANY_IMAGES");
  }
}

async function imageChange(app: FastifyInstance, principal: Principal, id: string, action: string, work: (tx: Sql, current: LockedApartment) => Promise<void>) {
  return withTransaction(app.db, async (tx) => {
    const current = await lockApartment(tx, principal.propertyId, id);
    await work(tx, current);
    await recordEvent(tx, { propertyId: principal.propertyId, actorId: principal.userId, action, entityType: "apartment", entityId: id, outbox: { type: "apartment.updated", reference: current.name } });
    return toApartmentView(await loadApartment(tx, principal.propertyId, id), principal.role, imageUrls(app.config));
  });
}

function requireImage(current: LockedApartment, imageId: string): ImageJson {
  const image = current.images.find((candidate) => candidate.id === imageId);
  if (!image) throw Errors.notFound("Photo not found");
  return image;
}

export function updateImage(app: FastifyInstance, principal: Principal, id: string, imageId: string, input: { caption?: string | null; isCover?: true }) {
  return imageChange(app, principal, id, "apartment.image_updated", async (tx, current) => {
    const image = requireImage(current, imageId);
    if (input.caption !== undefined) await tx.exec(`UPDATE apartment_images SET caption = $2 WHERE id = $1`, [imageId, textChange(input.caption, image.caption)]);
    if (input.isCover) {
      // Clear first: the partial unique index allows only one cover at a time.
      await tx.exec(`UPDATE apartment_images SET is_cover = false WHERE apartment_id = $1 AND is_cover AND id <> $2`, [id, imageId]);
      await tx.exec(`UPDATE apartment_images SET is_cover = true WHERE id = $1`, [imageId]);
    }
  });
}

export function reorderImages(app: FastifyInstance, principal: Principal, id: string, imageIds: readonly string[]) {
  return imageChange(app, principal, id, "apartment.images_reordered", async (tx, current) => {
    const known = new Set(current.images.map((image) => image.id));
    if (new Set(imageIds).size !== imageIds.length || imageIds.length !== known.size || imageIds.some((imageId) => !known.has(imageId))) {
      throw Errors.unprocessable("List every photo of this apartment exactly once", "VALIDATION_FAILED");
    }
    await tx.exec(`UPDATE apartment_images i SET position = o.position FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position) WHERE i.id = o.id`, [imageIds]);
  });
}

export async function deleteImage(app: FastifyInstance, principal: Principal, id: string, imageId: string) {
  let storageKey: string | null = null;
  const apartment = await imageChange(app, principal, id, "apartment.image_deleted", async (tx, current) => {
    const image = requireImage(current, imageId);
    if (current.status === "published" && current.image_count === 1) throw Errors.conflict("A published apartment needs at least one photo", "PHOTOS_REQUIRED");
    storageKey = image.storageKey;
    await tx.exec(`DELETE FROM apartment_images WHERE id = $1`, [imageId]);
    if (image.isCover) {
      await tx.exec(
        `UPDATE apartment_images SET is_cover = true
          WHERE id = (SELECT id FROM apartment_images WHERE apartment_id = $1 ORDER BY position, created_at, id LIMIT 1)`,
        [id],
      );
    }
  });
  // After commit: the photo is already gone from the listing, so a failed delete only leaves an orphaned object.
  const key: string | null = storageKey;
  if (key && app.storage) {
    await app.storage.delete(key).catch((error: unknown) => app.log.warn({ err: error, key }, "could not delete photo from R2; remove it manually"));
  }
  return apartment;
}
