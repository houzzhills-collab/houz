import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withConnection } from "../../db/sql.js";
import { addDays, businessToday, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import { OCCUPYING_STAY_SQL, SELLABLE_ROOM_SQL } from "../public/booking.service.js";
import { PublicDetailSchema, PublicImageSchema, PublicListSchema } from "./apartments.schemas.js";
import { APARTMENT_SELECT, type ApartmentRow } from "./apartments.service.js";
import { IMAGE_CACHE_CONTROL, imageUrl, imageUrls, type ImageUrls } from "./images.js";

const PRIMARY_PROPERTY = `(SELECT id FROM properties ORDER BY created_at, id LIMIT 1)`;

/** What guests may see. The exact address, coordinates and directions are shared after booking, not here. */
function toPublicView(row: ApartmentRow, urls: ImageUrls) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    bookingRoomType: row.name,
    category: row.category,
    summary: row.summary,
    description: row.description,
    location: { area: row.area, city: row.city, state: row.state, country: row.country },
    pricing: { nightlyRateKobo: row.nightly_rate_kobo, cautionFeeKobo: row.caution_fee_kobo, currency: "NGN" as const },
    capacity: { maxGuests: row.max_guests, bedrooms: row.bedrooms, bathrooms: row.bathrooms, beds: row.beds, sizeSqm: row.size_sqm },
    stayRules: { minimumNights: row.minimum_nights, checkInTime: row.check_in_time, checkOutTime: row.check_out_time },
    amenities: row.amenities,
    features: row.features,
    facilities: row.facilities,
    houseRules: row.house_rules,
    policies: { warranty: row.warranty_policy, cancellation: row.cancellation_policy },
    images: row.images.map((image) => ({ id: image.id, url: imageUrl(urls, row.id, image), caption: image.caption, isCover: image.isCover })),
  };
}

/** Joins touching or overlapping ranges, so guests see taken dates rather than individual bookings. */
export function mergeRanges(ranges: ReadonlyArray<{ checkIn: string; checkOut: string }>): Array<{ checkIn: string; checkOut: string }> {
  const merged: Array<{ checkIn: string; checkOut: string }> = [];
  for (const range of [...ranges].sort((a, b) => a.checkIn.localeCompare(b.checkIn))) {
    const last = merged[merged.length - 1];
    if (last && range.checkIn <= last.checkOut) {
      if (range.checkOut > last.checkOut) last.checkOut = range.checkOut;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Guest-facing apartment listings for the primary property. No login; rate limited. */
const publicApartmentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", { schema: PublicListSchema, config: { rateLimit: { max: 120, timeWindow: 60_000 } } }, async (request, reply) => {
    const { city, guests, checkIn, checkOut } = request.query;
    const limit = request.query.limit ?? 24;
    if ((checkIn === undefined) !== (checkOut === undefined)) throw Errors.unprocessable("Send checkIn and checkOut together", "VALIDATION_FAILED");
    let nights: number | null = null;
    if (checkIn && checkOut) {
      nights = nightsBetween(checkIn, checkOut);
      const rules = await app.settings.current();
      const today = businessToday();
      // Same rule as /public/availability: an impossible stay simply has nothing available.
      if (nights < 1 || nights > rules.maxStayNights || checkIn < today || checkIn > addDays(today, rules.horizonDays)) return { apartments: [], nextCursor: null };
    }
    const cursor = decodeCursor(request.query.cursor, 2);
    const rows = await withConnection(app.db, (sql) =>
      sql.rows<ApartmentRow>(
        `${APARTMENT_SELECT}
          WHERE a.property_id = ${PRIMARY_PROPERTY} AND a.status = 'published'
            AND ($1::text IS NULL OR lower(a.city) = lower($1))
            AND ($2::int IS NULL OR ro.capacity >= $2)
            AND ($3::date IS NULL OR (
                  a.minimum_nights <= $5 AND ${SELLABLE_ROOM_SQL}
                  AND NOT EXISTS (SELECT 1 FROM reservations r
                                   WHERE r.room_id = ro.id AND ${OCCUPYING_STAY_SQL}
                                     AND r.check_in < $4::date AND r.check_out > $3::date)))
            AND ($6::text IS NULL OR (a.name, a.id) > ($6::text, $7::uuid))
          ORDER BY a.name, a.id
          LIMIT $8`,
        [city?.trim() ? city.trim() : null, guests ?? null, checkIn ?? null, checkOut ?? null, nights, cursor?.[0] ?? null, cursor?.[1] ?? null, limit + 1],
      ),
    );
    const page = toPage(rows, limit, (row) => [row.name, row.id]);
    reply.header("cache-control", "public, max-age=60");
    return { apartments: page.items.map((row) => toPublicView(row, imageUrls(app.config))), nextCursor: page.nextCursor };
  });

  app.get("/:slug", { schema: PublicDetailSchema, config: { rateLimit: { max: 120, timeWindow: 60_000 } } }, async (request, reply) => {
    const rules = await app.settings.current();
    const today = businessToday();
    const result = await withConnection(app.db, async (sql) => {
      const row = await sql.maybeOne<ApartmentRow>(`${APARTMENT_SELECT} WHERE a.property_id = ${PRIMARY_PROPERTY} AND a.slug = $1 AND a.status = 'published'`, [request.params.slug]);
      if (!row) throw Errors.notFound("Apartment not found");
      const ranges = await sql.rows<{ checkIn: string; checkOut: string }>(
        `SELECT r.check_in::text AS "checkIn", r.check_out::text AS "checkOut" FROM reservations r
          WHERE r.room_id = $1 AND ${OCCUPYING_STAY_SQL} AND r.check_out > $2::date AND r.check_in < $3::date`,
        [row.room_id, today, addDays(today, rules.horizonDays + rules.maxStayNights)],
      );
      return { apartment: toPublicView(row, imageUrls(app.config)), bookedRanges: mergeRanges(ranges) };
    });
    reply.header("cache-control", "public, max-age=30");
    return result;
  });

  app.get("/:id/images/:imageId", { schema: PublicImageSchema, config: { rateLimit: { max: 600, timeWindow: 60_000 } } }, async (request, reply) => {
    // Photo ids are unguessable, so drafts can be previewed by staff through the same URL before publishing.
    const image = await withConnection(app.db, (sql) =>
      sql.maybeOne<{ content_type: string; sha256: string; data: Buffer | null; storage_key: string | null }>(
        `SELECT content_type, sha256, data, storage_key FROM apartment_images WHERE id = $1 AND apartment_id = $2`,
        [request.params.imageId, request.params.id],
      ),
    );
    if (!image) throw Errors.notFound("Photo not found");
    // Lets other sites the business runs (e.g. a marketing site) embed the photos.
    reply.header("cross-origin-resource-policy", "cross-origin");

    if (image.storage_key) {
      const urls = imageUrls(app.config);
      // A public bucket serves the photo from Cloudflare's CDN; this URL keeps working for older links.
      if (urls.publicBase) {
        return reply.header("cache-control", "public, max-age=86400").redirect(imageUrl(urls, request.params.id, { id: request.params.imageId, storageKey: image.storage_key }), 302);
      }
      if (!app.storage) throw Errors.unavailable("Photo storage is not configured on the server", "STORAGE_NOT_CONFIGURED");
    }
    const etag = `"${image.sha256}"`;
    reply.header("cache-control", IMAGE_CACHE_CONTROL).header("etag", etag);
    if (request.headers["if-none-match"] === etag) return reply.status(304).send(null);
    let data = image.data;
    if (image.storage_key && app.storage) {
      const stored = await app.storage.get(image.storage_key);
      if (!stored) throw Errors.notFound("Photo not found");
      data = stored.data;
    }
    return reply.type(image.content_type).send(data);
  });
};

export default publicApartmentRoutes;
