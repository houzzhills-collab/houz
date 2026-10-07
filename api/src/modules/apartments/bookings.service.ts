import type { FastifyInstance } from "fastify";
import { withConnection } from "../../db/sql.js";
import { addDays, businessToday, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import type { Principal } from "../auth/session.service.js";

/**
 * The booking tracker: reservations of apartment units with the booker's
 * details and the full payment picture. Reads only; bookings are created and
 * changed through the reservations endpoints as before.
 */

export type BookingFilters = {
  apartmentId?: string;
  from?: string;
  to?: string;
  status?: string[];
  paymentStatus?: string;
  q?: string;
};

const MAX_RANGE_DAYS = 366;

const BOOKINGS_JOINS = `
    FROM reservations r
    JOIN apartments a ON a.room_id = r.room_id
    JOIN rooms ro ON ro.id = r.room_id
    JOIN guests g ON g.id = r.guest_id`;

/** Apartment reservations matching parameters $1–$7. */
const BOOKINGS_WHERE = `
   WHERE r.property_id = $1
     AND ($2::uuid IS NULL OR a.id = $2)
     AND ($3::date IS NULL OR r.check_out > $3::date)
     AND ($4::date IS NULL OR r.check_in < $4::date)
     AND ($5::text[] IS NULL OR r.status = ANY($5::text[]))
     AND ($6::text IS NULL OR r.payment_status = $6)
     AND ($7::text IS NULL OR g.full_name ILIKE $7 ESCAPE '\\' OR g.email ILIKE $7 ESCAPE '\\' OR g.phone ILIKE $7 ESCAPE '\\' OR r.reference ILIKE $7 ESCAPE '\\')`;

type BookingRow = {
  id: string;
  reference: string;
  apartment_id: string;
  apartment_name: string;
  apartment_slug: string;
  unit_code: string;
  status: string;
  source: string;
  check_in: string;
  check_out: string;
  guests_count: number;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  notes: string | null;
  payment_status: string;
  amount_kobo: string;
  paid_kobo: string;
  pending_kobo: string;
  caution_fee_kobo: string;
  hold_expires_at: Date | null;
  created_by: string | null;
  created_at: Date;
  cursor_created: string;
  payments: Array<{
    id: string;
    amountKobo: string;
    method: string;
    status: string;
    reference: string | null;
    provider: string | null;
    recordedBy: string | null;
    confirmedBy: string | null;
    createdAt: string;
    settledAt: string | null;
  }>;
};

function params(propertyId: string, filters: BookingFilters): unknown[] {
  if (filters.from && filters.to) {
    const span = nightsBetween(filters.from, filters.to);
    if (span < 1 || span > MAX_RANGE_DAYS) throw Errors.unprocessable(`"to" must be after "from" and at most ${MAX_RANGE_DAYS} days later`, "INVALID_RANGE");
  }
  const like = filters.q?.trim() ? `%${filters.q.trim().replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
  return [propertyId, filters.apartmentId ?? null, filters.from ?? null, filters.to ?? null, filters.status?.length ? filters.status : null, filters.paymentStatus ?? null, like];
}

export async function listBookings(app: FastifyInstance, principal: Principal, filters: BookingFilters & { limit: number; cursor?: string }) {
  const values = params(principal.propertyId, filters);
  const cursor = decodeCursor(filters.cursor, 3);
  return withConnection(app.db, async (sql) => {
    const rows = await sql.rows<BookingRow>(
      `SELECT r.id, r.reference, a.id AS apartment_id, a.name AS apartment_name, a.slug AS apartment_slug, ro.room_number AS unit_code,
              r.status, r.source, r.check_in::text, r.check_out::text, r.guests_count, g.full_name AS guest_name, g.email AS guest_email,
              g.phone AS guest_phone, r.notes, r.payment_status, r.amount_kobo::text, coalesce(p.paid, 0)::text AS paid_kobo,
              coalesce(p.pending, 0)::text AS pending_kobo, a.caution_fee_kobo::text, r.hold_expires_at, creator.full_name AS created_by,
              r.created_at, r.created_at::text AS cursor_created, coalesce(p.payments, '[]'::json) AS payments
         ${BOOKINGS_JOINS}
         LEFT JOIN users creator ON creator.id = r.created_by
         LEFT JOIN LATERAL (
           SELECT sum(pm.amount_kobo) FILTER (WHERE pm.status = 'settled') AS paid,
                  -- Unfinished online checkouts are not money on the way; staff-recorded transfers are.
                  sum(pm.amount_kobo) FILTER (WHERE pm.status = 'pending' AND pm.method <> 'online') AS pending,
                  json_agg(json_build_object('id', pm.id, 'amountKobo', pm.amount_kobo::text, 'method', pm.method, 'status', pm.status,
                                             'reference', pm.provider_reference, 'provider', pm.provider, 'recordedBy', recorder.full_name,
                                             'confirmedBy', confirmer.full_name, 'createdAt', pm.created_at, 'settledAt', pm.settled_at)
                           ORDER BY pm.created_at) AS payments
             FROM payments pm
             LEFT JOIN users recorder ON recorder.id = pm.recorded_by
             LEFT JOIN users confirmer ON confirmer.id = pm.confirmed_by
            WHERE pm.reservation_id = r.id) p ON true
         ${BOOKINGS_WHERE}
          AND ($8::date IS NULL OR (r.check_in, r.created_at, r.id) < ($8::date, $9::timestamptz, $10::uuid))
        ORDER BY r.check_in DESC, r.created_at DESC, r.id DESC
        LIMIT $11`,
      [...values, cursor?.[0] ?? null, cursor?.[1] ?? null, cursor?.[2] ?? null, filters.limit + 1],
    );
    const totals = await sql.one<{ count: number; amount: string; paid: string }>(
      `SELECT count(*)::int AS count, coalesce(sum(r.amount_kobo), 0)::text AS amount,
              coalesce(sum((SELECT coalesce(sum(pm.amount_kobo), 0) FROM payments pm WHERE pm.reservation_id = r.id AND pm.status = 'settled')), 0)::text AS paid
         ${BOOKINGS_JOINS}
         ${BOOKINGS_WHERE}`,
      values,
    );
    const page = toPage(rows, filters.limit, (row) => [row.check_in, row.cursor_created, row.id]);
    return {
      bookings: page.items.map(toBooking),
      nextCursor: page.nextCursor,
      totals: {
        count: totals.count,
        amountKobo: totals.amount,
        paidKobo: totals.paid,
        balanceKobo: maxZero(BigInt(totals.amount) - BigInt(totals.paid)),
      },
    };
  });
}

function maxZero(value: bigint): string {
  return (value > 0n ? value : 0n).toString();
}

/** Ended stays owe nothing more; the balance is what is still expected for an active booking. */
const CLOSED = new Set(["cancelled", "no_show", "expired"]);

function toBooking(row: BookingRow) {
  const balance = CLOSED.has(row.status) ? "0" : maxZero(BigInt(row.amount_kobo) - BigInt(row.paid_kobo));
  return {
    id: row.id,
    reference: row.reference,
    apartment: { id: row.apartment_id, name: row.apartment_name, unitCode: row.unit_code, slug: row.apartment_slug },
    status: row.status,
    source: row.source,
    checkIn: row.check_in,
    checkOut: row.check_out,
    nights: nightsBetween(row.check_in, row.check_out),
    guests: row.guests_count,
    booker: { name: row.guest_name, email: row.guest_email, phone: row.guest_phone },
    notes: row.notes,
    payment: {
      status: row.payment_status,
      amountKobo: row.amount_kobo,
      paidKobo: row.paid_kobo,
      pendingKobo: row.pending_kobo,
      balanceKobo: balance,
      cautionFeeKobo: row.caution_fee_kobo,
      payments: row.payments,
    },
    holdExpiresAt: row.hold_expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function apartmentCalendar(app: FastifyInstance, principal: Principal, apartmentId: string, range: { from?: string; to?: string }) {
  const from = range.from ?? businessToday();
  const to = range.to ?? addDays(from, 90);
  const nights = nightsBetween(from, to);
  if (nights < 1 || nights > MAX_RANGE_DAYS) throw Errors.unprocessable(`"to" must be after "from" and at most ${MAX_RANGE_DAYS} days later`, "INVALID_RANGE");

  return withConnection(app.db, async (sql) => {
    const apartment = await sql.maybeOne<{ id: string; name: string; unit_code: string; room_id: string }>(
      `SELECT a.id, a.name, ro.room_number AS unit_code, a.room_id FROM apartments a JOIN rooms ro ON ro.id = a.room_id WHERE a.id = $1 AND a.property_id = $2`,
      [apartmentId, principal.propertyId],
    );
    if (!apartment) throw Errors.notFound("Apartment not found");
    const stays = await sql.rows<{
      reservationId: string;
      reference: string;
      status: string;
      paymentStatus: string;
      checkIn: string;
      checkOut: string;
      guestName: string;
      guests: number;
      amount_kobo: string;
      paid_kobo: string;
    }>(
      `SELECT r.id AS "reservationId", r.reference, r.status, r.payment_status AS "paymentStatus", r.check_in::text AS "checkIn",
              r.check_out::text AS "checkOut", g.full_name AS "guestName", r.guests_count AS guests, r.amount_kobo::text,
              (SELECT coalesce(sum(amount_kobo), 0) FROM payments WHERE reservation_id = r.id AND status = 'settled')::text AS paid_kobo
         FROM reservations r JOIN guests g ON g.id = r.guest_id
        WHERE r.room_id = $1 AND r.check_in < $3::date AND r.check_out > $2::date
          AND (r.status IN ('confirmed', 'checked_in', 'checked_out') OR (r.status = 'pending_payment' AND r.hold_expires_at > now()))
        ORDER BY r.check_in`,
      [apartment.room_id, from, to],
    );
    let bookedNights = 0;
    let booked = 0n;
    let paid = 0n;
    for (const stay of stays) {
      // Count only the nights that fall inside the period.
      const start = stay.checkIn > from ? stay.checkIn : from;
      const end = stay.checkOut < to ? stay.checkOut : to;
      bookedNights += Math.max(0, nightsBetween(start, end));
      if (stay.status !== "pending_payment") {
        booked += BigInt(stay.amount_kobo);
        paid += BigInt(stay.paid_kobo);
      }
    }
    return {
      apartment: { id: apartment.id, name: apartment.name, unitCode: apartment.unit_code },
      from,
      to,
      stays: stays.map((stay) => ({
        reservationId: stay.reservationId,
        reference: stay.reference,
        status: stay.status,
        paymentStatus: stay.paymentStatus,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        guestName: stay.guestName,
        guests: stay.guests,
      })),
      stats: {
        nights,
        bookedNights,
        occupancyPercent: Math.min(100, Math.round((bookedNights / nights) * 100)),
        bookedAmountKobo: booked.toString(),
        paidKobo: paid.toString(),
      },
    };
  });
}
