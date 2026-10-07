import { randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { withConnection, withTransaction, type Sql } from "../../db/sql.js";
import { sha256Hex } from "../../lib/crypto.js";
import { addDays, businessToday, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { recordEvent } from "../../lib/events.js";
import { notifyBookingHeld, notifyBookingReceived } from "../email/notifications.js";
import type { GlobalSettings } from "../settings/settings.registry.js";
import { expireLapsedHolds, refreshReservationPayment } from "../payments/ledger.js";

/** Statuses that occupy a room for their dates (holds only while unexpired). */
export const OCCUPYING_STAY_SQL = `
  r.status IN ('hold', 'pending_payment', 'confirmed', 'checked_in')
  AND (r.status NOT IN ('hold', 'pending_payment') OR r.hold_expires_at > now())`;

/** Rooms that can be sold: active and not taken out of service. */
export const SELLABLE_ROOM_SQL = `ro.active AND ro.status NOT IN ('maintenance', 'out_of_order')`;

/** Units whose apartment (if any) accepts a stay of `nightsParam` nights. */
export const MEETS_MINIMUM_STAY_SQL = (nightsParam: string) =>
  `NOT EXISTS (SELECT 1 FROM apartments ap WHERE ap.room_id = ro.id AND ap.minimum_nights > ${nightsParam}::int)`;

/** Rejects a stay shorter than the apartment's minimum, with a message the guest can act on. */
export async function assertMinimumStay(sql: Sql, roomId: string, nights: number): Promise<void> {
  const apartment = await sql.maybeOne<{ name: string; minimum_nights: number }>(`SELECT name, minimum_nights FROM apartments WHERE room_id = $1`, [roomId]);
  if (apartment && nights < apartment.minimum_nights) {
    throw Errors.unprocessable(`${apartment.name} needs a stay of at least ${apartment.minimum_nights} nights`, "MINIMUM_STAY");
  }
}

export type StayDates = { checkIn: string; checkOut: string; nights: number };

/** Validates a stay against today's business date, the maximum length and the booking horizon. */
export function validateStay(rules: Pick<GlobalSettings, "maxStayNights" | "horizonDays">, checkIn: string, checkOut: string): StayDates {
  const nights = nightsBetween(checkIn, checkOut);
  const today = businessToday();
  const { maxStayNights, horizonDays } = rules;
  if (nights < 1 || nights > maxStayNights) throw Errors.unprocessable(`Choose a stay of 1 to ${maxStayNights} nights`, "INVALID_STAY");
  if (checkIn < today) throw Errors.unprocessable("Check-in must be today or a future date", "INVALID_STAY");
  if (checkIn > addDays(today, horizonDays)) throw Errors.unprocessable(`Bookings open ${horizonDays} days ahead`, "INVALID_STAY");
  return { checkIn, checkOut, nights };
}

/** Letters and digits that cannot be misread for each other (no 0/O, 1/I/L). */
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * Website booking reference a guest can read out or type, such as HH-K7QM-4XPA-9C.
 * About 50 bits of randomness: the status page shows no guest data, and every
 * page that does also needs the booking's email address.
 */
export function publicReference(): string {
  const chars = Array.from({ length: 10 }, () => REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)]).join("");
  return `HH-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** Accepts a reference as a guest might type it: any case, with or without the HH- prefix or dashes. */
export function normalizeReference(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  const body = compact.startsWith("HH") ? compact.slice(2) : compact;
  if (body.length === 10 && [...body].every((char) => REFERENCE_ALPHABET.includes(char))) {
    return `HH-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`;
  }
  // References issued before short references existed are matched as given.
  const legacy = input.trim().toUpperCase();
  return /^HH-[A-Z0-9-]{8,64}$/.test(legacy) ? legacy : null;
}

/** Short staff reference; not accepted by the public status endpoint. */
export function staffReference(): string {
  return `HH-${Date.now().toString(36).toUpperCase()}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function primaryPropertyId(sql: Sql): Promise<string> {
  const property = await sql.maybeOne<{ id: string }>(`SELECT id FROM properties ORDER BY created_at, id LIMIT 1`);
  if (!property) throw Errors.unavailable("Bookings are not configured yet", "PROPERTY_NOT_CONFIGURED");
  return property.id;
}

export async function insertGuest(tx: Sql, propertyId: string, guest: { name: string; email: string | null; phone: string | null }): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO guests(property_id, full_name, email, phone) VALUES ($1, $2, $3, $4) RETURNING id`,
    [propertyId, guest.name, guest.email, guest.phone],
  );
  return row.id;
}

type PublicBookingInput = {
  name: string;
  email: string;
  phone: string | null;
  roomType: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  notes: string | null;
  /** Hold the room for the pay-later window instead of starting checkout now. */
  payLater: boolean;
  idempotencyKey: string;
  fingerprint: string;
};

type BookingResult = {
  reservation: { id: string; reference: string; amountKobo: string; currency: "NGN"; status: "pending_payment"; holdExpiresAt: string; payLater: boolean };
  /** Null for a pay-later booking: the guest pays later from their booking page. */
  checkoutUrl: string | null;
};

type ExistingBooking = {
  id: string;
  reference: string;
  amount_kobo: string;
  status: string;
  hold_expires_at: Date | null;
  checkout_url: string | null;
  request_fingerprint: string | null;
  pay_later: boolean;
};

/**
 * Public booking + hosted checkout (PRD §4.1). The room is chosen and held in a
 * short transaction; the provider call happens after commit so no database lock
 * is held across the network. A failed checkout start releases the hold.
 */
export async function createPublicBooking(app: FastifyInstance, input: PublicBookingInput): Promise<BookingResult> {
  const rules = await app.settings.current();
  const provider = input.payLater ? null : await app.payments.provider();
  const webUrl = app.config.payments.publicWebUrl;
  if (input.payLater) {
    if (rules.payLaterHours < 1) throw Errors.unprocessable("Pay later is not available at the moment. Please pay now to book.", "PAY_LATER_UNAVAILABLE");
  } else if (!provider || !webUrl) {
    throw Errors.unavailable("Online payment is temporarily unavailable. Please contact the property to book.", "PAYMENTS_UNAVAILABLE");
  }
  const stay = validateStay(rules, input.checkIn, input.checkOut);
  const paymentKey = `public:${sha256Hex(input.idempotencyKey)}`;
  const holdMinutes = input.payLater ? rules.payLaterHours * 60 : rules.holdMinutes;

  const held = await withTransaction(app.db, async (tx) => {
    const propertyId = await primaryPropertyId(tx);
    // Pay-now attempts keep their key on the payment; pay-later ones (no payment yet) on the reservation.
    const existing = await tx.maybeOne<ExistingBooking>(
      `SELECT r.id, r.reference, r.amount_kobo::text, r.status, r.hold_expires_at, p.checkout_url, p.request_fingerprint, r.pay_later
         FROM payments p JOIN reservations r ON r.id = p.reservation_id
        WHERE p.property_id = $1 AND p.idempotency_key = $2
       UNION ALL
       SELECT r.id, r.reference, r.amount_kobo::text, r.status, r.hold_expires_at, NULL, r.request_fingerprint, r.pay_later
         FROM reservations r
        WHERE r.property_id = $1 AND r.idempotency_key = $2
       LIMIT 1`,
      [propertyId, paymentKey],
    );
    if (existing) return { kind: "replay" as const, prior: existing };

    const room = await tx.maybeOne<{ id: string; nightly_rate_kobo: string }>(
      `SELECT ro.id, ro.nightly_rate_kobo::text FROM rooms ro
        WHERE ro.property_id = $1 AND ro.room_type = $2 AND ro.capacity >= $3 AND ${SELLABLE_ROOM_SQL} AND ${MEETS_MINIMUM_STAY_SQL("$6")}
          AND NOT EXISTS (SELECT 1 FROM reservations r
                           WHERE r.room_id = ro.id AND ${OCCUPYING_STAY_SQL}
                             AND r.check_in < $5::date AND r.check_out > $4::date)
        ORDER BY ro.room_number
        LIMIT 1
        FOR UPDATE OF ro SKIP LOCKED`,
      [propertyId, input.roomType, input.guests, stay.checkIn, stay.checkOut, stay.nights],
    );
    if (!room) {
      // A clearer reason when the only obstacle is the apartment's minimum stay.
      const apartment = await tx.maybeOne<{ room_id: string }>(
        `SELECT ap.room_id FROM apartments ap JOIN rooms ro ON ro.id = ap.room_id WHERE ro.property_id = $1 AND ro.room_type = $2`,
        [propertyId, input.roomType],
      );
      if (apartment) await assertMinimumStay(tx, apartment.room_id, stay.nights);
      throw Errors.conflict("That room type is unavailable for the selected dates", "ROOM_UNAVAILABLE");
    }
    // Lapsed holds on this room still count for the exclusion constraint until expired.
    await expireLapsedHolds(tx, { roomId: room.id, limit: 100 });

    const amount = BigInt(room.nightly_rate_kobo) * BigInt(stay.nights);
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw Errors.unavailable("This room is not currently available for online payment. Please contact the property.", "PRICE_NOT_PAYABLE");
    }
    const guestId = await insertGuest(tx, propertyId, { name: input.name, email: input.email, phone: input.phone });
    const reference = publicReference();
    const reservation = await tx.one<{ id: string; hold_expires_at: Date }>(
      `INSERT INTO reservations(property_id, guest_id, reference, room_id, room_type, check_in, check_out, guests_count,
                                amount_kobo, status, source, payment_status, notes, hold_expires_at, pay_later, idempotency_key, request_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', 'public_website', $10, $11,
               now() + make_interval(mins => $12), $13, $14, $15)
       RETURNING id, hold_expires_at`,
      [
        propertyId,
        guestId,
        reference,
        room.id,
        input.roomType,
        stay.checkIn,
        stay.checkOut,
        input.guests,
        amount.toString(),
        input.payLater ? "unpaid" : "pending",
        input.notes,
        holdMinutes,
        input.payLater,
        input.payLater ? paymentKey : null,
        input.payLater ? input.fingerprint : null,
      ],
    );
    if (provider) {
      await tx.exec(
        `INSERT INTO payments(property_id, reservation_id, amount_kobo, method, status, provider, provider_reference, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, 'online', 'pending', $4, $5, $6, $7)`,
        [propertyId, reservation.id, amount.toString(), provider.name, reference, paymentKey, input.fingerprint],
      );
    }
    await recordEvent(tx, {
      propertyId,
      actorId: null,
      action: "reservation.created",
      entityType: "reservation",
      entityId: reservation.id,
      details: { source: "public_website", roomId: room.id, amountKobo: amount.toString(), payLater: input.payLater },
      outbox: { reference },
    });
    if (input.payLater) await notifyBookingHeld(tx, reservation.id, { expiresAt: reservation.hold_expires_at });
    return { kind: "created" as const, booking: { id: reservation.id, reference, amountKobo: amount.toString(), holdExpiresAt: reservation.hold_expires_at, propertyId } };
  });

  if (held.kind === "replay") {
    const { prior } = held;
    if (prior.request_fingerprint !== input.fingerprint) {
      throw Errors.conflict("This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
    }
    if (prior.status !== "pending_payment" || (!prior.pay_later && !prior.checkout_url) || !prior.hold_expires_at || prior.hold_expires_at.getTime() <= Date.now()) {
      throw Errors.conflict("This booking attempt has ended. Start a new booking.", "BOOKING_ATTEMPT_CLOSED");
    }
    return {
      reservation: {
        id: prior.id,
        reference: prior.reference,
        amountKobo: prior.amount_kobo,
        currency: "NGN",
        status: "pending_payment",
        holdExpiresAt: prior.hold_expires_at.toISOString(),
        payLater: prior.pay_later,
      },
      checkoutUrl: prior.pay_later ? null : prior.checkout_url,
    };
  }

  const { booking } = held;
  const view = { id: booking.id, reference: booking.reference, amountKobo: booking.amountKobo, currency: "NGN" as const, status: "pending_payment" as const, holdExpiresAt: booking.holdExpiresAt.toISOString(), payLater: input.payLater };
  if (!provider || !webUrl) return { reservation: view, checkoutUrl: null };

  let checkoutUrl: string;
  try {
    ({ checkoutUrl } = await provider.initializeCheckout({
      reference: booking.reference,
      amountKobo: Number(booking.amountKobo),
      email: input.email,
      name: input.name,
      callbackUrl: `${webUrl}/payment-result?reference=${encodeURIComponent(booking.reference)}`,
    }));
  } catch (error) {
    // No charge can exist without a checkout session, so release the room. ProviderError maps to 502.
    app.log.error({ err: error, reference: booking.reference }, "checkout initialization failed");
    await releaseFailedCheckout(app, booking.id, booking.propertyId, booking.reference);
    throw error;
  }
  await withTransaction(app.db, async (tx) => {
    await tx.exec(`UPDATE payments SET checkout_url = $2 WHERE reservation_id = $1 AND method = 'online'`, [booking.id, checkoutUrl]);
    await notifyBookingReceived(tx, booking.id, { expiresAt: booking.holdExpiresAt, checkoutUrl });
  });
  return { reservation: view, checkoutUrl };
}

type PayableBooking = {
  id: string;
  property_id: string;
  reference: string;
  status: string;
  amount_kobo: string;
  hold_valid: boolean;
  guest_name: string;
  guest_email: string;
};

/**
 * Starts (or resumes) online payment for a website booking that is still held:
 * a pay-later booking, or a pay-now booking whose guest left checkout. The
 * guest proves it is their booking with the reference and email together.
 * A booking has at most one online payment, whose provider reference is the
 * booking reference, so a resumed checkout reuses the session already started.
 */
export async function startGuestCheckout(app: FastifyInstance, input: { reference: string; email: string }): Promise<{ checkoutUrl: string }> {
  const provider = await app.payments.provider();
  const webUrl = app.config.payments.publicWebUrl;
  if (!provider || !webUrl) throw Errors.unavailable("Online payment is temporarily unavailable. Please contact the property to pay.", "PAYMENTS_UNAVAILABLE");

  const prepared = await withTransaction(app.db, async (tx) => {
    const booking = await tx.maybeOne<PayableBooking>(
      `SELECT r.id, r.property_id, r.reference, r.status, r.amount_kobo::text, coalesce(r.hold_expires_at > now(), false) AS hold_valid,
              g.full_name AS guest_name, g.email AS guest_email
         FROM reservations r JOIN guests g ON g.id = r.guest_id
        WHERE r.reference = $1 AND r.source = 'public_website' AND lower(g.email) = $2
        FOR UPDATE OF r`,
      [input.reference, input.email],
    );
    if (!booking) throw Errors.notFound("We couldn't find a booking with that reference and email", "BOOKING_NOT_FOUND");
    if (booking.status === "confirmed" || booking.status === "checked_in" || booking.status === "checked_out") {
      throw Errors.conflict("This booking is already confirmed", "BOOKING_ALREADY_CONFIRMED");
    }
    if (booking.status !== "pending_payment" || !booking.hold_valid) {
      throw Errors.conflict("This booking's hold has ended, so it can no longer be paid. Please make a new booking.", "BOOKING_NOT_PAYABLE");
    }
    const online = await tx.maybeOne<{ id: string; status: string; checkout_url: string | null }>(
      `SELECT id, status, checkout_url FROM payments WHERE reservation_id = $1 AND method = 'online' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [booking.id],
    );
    if (online?.status === "pending" && online.checkout_url) return { kind: "resume" as const, checkoutUrl: online.checkout_url };
    if (online && online.status !== "pending") throw Errors.conflict("This booking's online payment has already been processed", "BOOKING_NOT_PAYABLE");

    const totals = await tx.one<{ settled: string; pending_other: string }>(
      `SELECT coalesce(sum(amount_kobo) FILTER (WHERE status = 'settled'), 0)::text AS settled,
              coalesce(sum(amount_kobo) FILTER (WHERE status = 'pending' AND method <> 'online'), 0)::text AS pending_other
         FROM payments WHERE reservation_id = $1`,
      [booking.id],
    );
    if (BigInt(totals.pending_other) > 0n) throw Errors.conflict("A payment for this booking is being verified. Please contact the property.", "PAYMENT_BEING_VERIFIED");
    const balance = BigInt(booking.amount_kobo) - BigInt(totals.settled);
    if (balance <= 0n) throw Errors.conflict("Nothing is due on this booking", "NOTHING_DUE");

    let paymentId = online?.id;
    const created = !paymentId;
    if (!paymentId) {
      const inserted = await tx.one<{ id: string }>(
        `INSERT INTO payments(property_id, reservation_id, amount_kobo, method, status, provider, provider_reference)
         VALUES ($1, $2, $3, 'online', 'pending', $4, $5) RETURNING id`,
        [booking.property_id, booking.id, balance.toString(), provider.name, booking.reference],
      );
      paymentId = inserted.id;
      await refreshReservationPayment(tx, booking.id);
    }
    return { kind: "start" as const, booking, paymentId, created, amountKobo: balance };
  });
  if (prepared.kind === "resume") return { checkoutUrl: prepared.checkoutUrl };

  const { booking, paymentId, created, amountKobo } = prepared;
  let checkoutUrl: string;
  try {
    ({ checkoutUrl } = await provider.initializeCheckout({
      reference: booking.reference,
      amountKobo: Number(amountKobo),
      email: booking.guest_email,
      name: booking.guest_name,
      callbackUrl: `${webUrl}/payment-result?reference=${encodeURIComponent(booking.reference)}`,
    }));
  } catch (error) {
    // No checkout session means no charge: drop the attempt and keep the hold so the guest can try again.
    // A row another request created may still be getting its session, so only our own is removed.
    app.log.error({ err: error, reference: booking.reference }, "checkout initialization failed");
    if (created) {
      await withTransaction(app.db, async (tx) => {
        await tx.exec(`DELETE FROM payments WHERE id = $1 AND status = 'pending' AND checkout_url IS NULL`, [paymentId]);
        await refreshReservationPayment(tx, booking.id);
      });
    }
    throw error;
  }
  await withConnection(app.db, (sql) => sql.exec(`UPDATE payments SET checkout_url = $2 WHERE id = $1`, [paymentId, checkoutUrl]));
  return { checkoutUrl };
}

/** Compensates a booking whose checkout could not be started: no charge exists, so the hold is released. */
async function releaseFailedCheckout(app: FastifyInstance, reservationId: string, propertyId: string, reference: string): Promise<void> {
  await withTransaction(app.db, async (tx) => {
    await tx.exec(`UPDATE payments SET status = 'failed' WHERE reservation_id = $1 AND method = 'online' AND status = 'pending'`, [reservationId]);
    const released = await tx.exec(`UPDATE reservations SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [reservationId]);
    if (released === 0) return;
    await refreshReservationPayment(tx, reservationId);
    await recordEvent(tx, {
      propertyId,
      actorId: null,
      action: "reservation.checkout_failed",
      entityType: "reservation",
      entityId: reservationId,
      outbox: { reference },
    });
  });
}
