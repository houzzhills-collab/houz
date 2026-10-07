import { randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withConnection, withTransaction } from "../../db/sql.js";
import { randomToken, safeEqualHex, sha256Hex } from "../../lib/crypto.js";
import { nightsBetween } from "../../lib/dates.js";
import { AppError, Errors } from "../../lib/errors.js";
import { queueEmail } from "../email/queue.js";
import { primaryPropertyId } from "./booking.service.js";

/**
 * Guests see their bookings without an account. One booking opens with its
 * reference and email together; every booking for an email opens with a
 * one-time code sent to that address, which starts a short guest session.
 * Codes and sessions live in Redis only: nothing here is a staff credential.
 */

export const CODE_TTL_MINUTES = 10;
/** One code request per email per minute; the IP rate limit bounds the rest. */
const CODE_RESEND_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;
export const GUEST_SESSION_TTL_SECONDS = 30 * 60;
const MAX_BOOKINGS = 100;

const codeKey = (email: string) => `guest:code:${sha256Hex(email)}`;
const resendKey = (email: string) => `guest:code-wait:${sha256Hex(email)}`;
const sessionKey = (token: string) => `guest:session:${sha256Hex(token)}`;
const codeDigest = (email: string, code: string) => sha256Hex(`${email}:${code}`);

/** Redis failures become a clear 503 instead of a 500; this feature cannot work without it. */
async function guarded<T>(app: FastifyInstance, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    app.log.error({ err: error }, "guest booking access unavailable");
    throw Errors.unavailable("Booking lookup is temporarily unavailable. Please try again shortly.", "GUEST_ACCESS_UNAVAILABLE");
  }
}

/**
 * Emails a one-time code when the address has bookings. The caller always gets
 * the same answer, so the endpoint does not reveal who has booked.
 */
export async function requestAccessCode(app: FastifyInstance, email: string): Promise<void> {
  const first = await guarded(app, () => app.redis.set(resendKey(email), "1", "EX", CODE_RESEND_SECONDS, "NX"));
  if (first === null) return;

  await withTransaction(app.db, async (tx) => {
    const propertyId = await primaryPropertyId(tx);
    const guest = await tx.maybeOne<{ full_name: string }>(
      `SELECT g.full_name FROM guests g JOIN reservations r ON r.guest_id = g.id
        WHERE g.property_id = $1 AND lower(g.email) = $2
        ORDER BY r.created_at DESC LIMIT 1`,
      [propertyId, email],
    );
    if (!guest) return;
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const key = codeKey(email);
    await guarded(app, () =>
      app.redis
        .multi()
        .del(key)
        .hset(key, { digest: codeDigest(email, code), attempts: "0" })
        .expire(key, CODE_TTL_MINUTES * 60)
        .exec(),
    );
    // The code is sealed in the outbox like a temporary password, never stored in plain text.
    await queueEmail(tx, {
      propertyId,
      template: "guest.access_code",
      to: { email, name: guest.full_name },
      data: { expiresMinutes: CODE_TTL_MINUTES },
      sealed: { key: app.config.settingsEncryptionKey, values: { code } },
    });
  });
}

/** Exchanges a correct, unexpired code for a guest session token. A code works once and allows a few attempts. */
export async function verifyAccessCode(app: FastifyInstance, email: string, code: string): Promise<{ token: string; expiresAt: string }> {
  const invalid = () => Errors.unauthorized("That code is incorrect or has expired. Check the latest email or request a new code.", "INVALID_CODE");
  const key = codeKey(email);
  return guarded(app, async () => {
    const digest = await app.redis.hget(key, "digest");
    if (!digest) throw invalid();
    const attempts = await app.redis.hincrby(key, "attempts", 1);
    if (attempts > MAX_CODE_ATTEMPTS) {
      await app.redis.del(key);
      throw Errors.tooManyRequests("Too many incorrect codes. Request a new code.", "TOO_MANY_CODE_ATTEMPTS");
    }
    if (!safeEqualHex(digest, codeDigest(email, code))) throw invalid();
    // Only one request can consume the code.
    if ((await app.redis.del(key)) === 0) throw invalid();
    const token = randomToken(32);
    await app.redis.set(sessionKey(token), email, "EX", GUEST_SESSION_TTL_SECONDS);
    return { token, expiresAt: new Date(Date.now() + GUEST_SESSION_TTL_SECONDS * 1000).toISOString() };
  });
}

/** The email a guest session belongs to. */
export async function sessionEmail(app: FastifyInstance, token: string): Promise<string> {
  const email = await guarded(app, () => app.redis.get(sessionKey(token)));
  if (!email) throw Errors.unauthorized("Your session has ended. Request a new code to see your bookings.", "GUEST_SESSION_EXPIRED");
  return email;
}

export async function endSession(app: FastifyInstance, token: string): Promise<void> {
  await guarded(app, () => app.redis.del(sessionKey(token)));
}

type GuestBookingRow = {
  reference: string;
  status: string;
  source: string;
  pay_later: boolean;
  check_in: string;
  check_out: string;
  guests_count: number;
  amount_kobo: string;
  paid_kobo: string;
  payment_status: string;
  hold_expires_at: Date | null;
  hold_valid: boolean;
  created_at: Date;
  notes: string | null;
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  stay_name: string;
  unit_code: string | null;
  apartment_slug: string | null;
  address: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  caution_fee_kobo: string | null;
  payments: Array<{ amountKobo: string; method: string; status: string; at: string }>;
};

const GUEST_BOOKING_SELECT = `
  SELECT r.reference, r.status, r.source, r.pay_later, r.check_in::text, r.check_out::text, r.guests_count, r.amount_kobo::text,
         coalesce(p.paid, 0)::text AS paid_kobo, r.payment_status, r.hold_expires_at, coalesce(r.hold_expires_at > now(), false) AS hold_valid,
         r.created_at, r.notes, g.full_name AS guest_name, g.email AS guest_email, g.phone AS guest_phone,
         coalesce(a.name, ro.room_type, r.room_type) AS stay_name, ro.room_number AS unit_code, a.slug AS apartment_slug,
         nullif(concat_ws(', ', a.address_line, a.area, a.city, a.state), '') AS address, a.check_in_time, a.check_out_time,
         a.caution_fee_kobo::text, coalesce(p.payments, '[]'::json) AS payments
    FROM reservations r
    JOIN guests g ON g.id = r.guest_id
    LEFT JOIN rooms ro ON ro.id = r.room_id
    LEFT JOIN apartments a ON a.room_id = r.room_id
    LEFT JOIN LATERAL (
      SELECT sum(pm.amount_kobo) FILTER (WHERE pm.status = 'settled') AS paid,
             -- Unfinished online checkouts and failed attempts are not payments the guest made.
             json_agg(json_build_object('amountKobo', pm.amount_kobo::text, 'method', pm.method, 'status', pm.status,
                                        'at', coalesce(pm.settled_at, pm.created_at)) ORDER BY pm.created_at)
               FILTER (WHERE pm.status = 'settled' OR (pm.status = 'pending' AND pm.method <> 'online')) AS payments
        FROM payments pm WHERE pm.reservation_id = r.id) p ON true
   WHERE r.property_id = (SELECT id FROM properties ORDER BY created_at, id LIMIT 1) AND lower(g.email) = $1`;

/** Ended stays owe nothing more. */
const CLOSED = new Set(["cancelled", "no_show", "expired"]);
/** The exact address is shared once a stay is confirmed, as in the confirmation email. */
const ADDRESS_VISIBLE = new Set(["confirmed", "checked_in", "checked_out"]);

function toGuestBooking(row: GuestBookingRow) {
  const balance = CLOSED.has(row.status) ? 0n : BigInt(row.amount_kobo) - BigInt(row.paid_kobo);
  const held = row.status === "pending_payment" && row.hold_valid;
  return {
    reference: row.reference,
    status: row.status,
    bookedOnline: row.source === "public_website",
    payLater: row.pay_later,
    bookedAt: row.created_at,
    holdExpiresAt: held ? row.hold_expires_at : null,
    checkIn: row.check_in,
    checkOut: row.check_out,
    nights: nightsBetween(row.check_in, row.check_out),
    guests: row.guests_count,
    guest: { name: row.guest_name, email: row.guest_email, phone: row.guest_phone },
    notes: row.notes,
    stay: {
      name: row.stay_name,
      unitCode: row.unit_code,
      apartmentSlug: row.apartment_slug,
      address: ADDRESS_VISIBLE.has(row.status) ? row.address : null,
      checkInTime: row.check_in_time,
      checkOutTime: row.check_out_time,
    },
    payment: {
      status: row.payment_status,
      amountKobo: row.amount_kobo,
      paidKobo: row.paid_kobo,
      balanceKobo: (balance > 0n ? balance : 0n).toString(),
      cautionFeeKobo: row.caution_fee_kobo ?? "0",
      payments: row.payments,
    },
    // Only website bookings still on hold can be paid online; staff take payment for the rest.
    canPay: held && row.source === "public_website" && balance > 0n,
  };
}

export type GuestBooking = ReturnType<typeof toGuestBooking>;

/** One booking, by reference and the email it was made with. Wrong pairs and unknown references look the same. */
export async function findGuestBooking(app: FastifyInstance, reference: string, email: string): Promise<GuestBooking> {
  const row = await withConnection(app.db, (sql) => sql.maybeOne<GuestBookingRow>(`${GUEST_BOOKING_SELECT} AND r.reference = $2`, [email, reference]));
  if (!row) throw Errors.notFound("We couldn't find a booking with that reference and email", "BOOKING_NOT_FOUND");
  return toGuestBooking(row);
}

/** Every booking made with an email, newest stay first. */
export async function listGuestBookings(app: FastifyInstance, email: string): Promise<GuestBooking[]> {
  const rows = await withConnection(app.db, (sql) =>
    sql.rows<GuestBookingRow>(`${GUEST_BOOKING_SELECT} ORDER BY r.check_in DESC, r.created_at DESC LIMIT ${MAX_BOOKINGS}`, [email]),
  );
  return rows.map(toGuestBooking);
}
