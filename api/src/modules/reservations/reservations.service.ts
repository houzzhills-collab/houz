import type { FastifyInstance } from "fastify";
import { withConnection, withTransaction, type Sql } from "../../db/sql.js";
import { businessToday, nightsBetween } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { hasPermission, type Role } from "../../lib/permissions.js";
import { recordEvent } from "../../lib/events.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import type { Principal } from "../auth/session.service.js";
import { alertTransferPending, notifyGuestPayment, notifyGuestStay } from "../email/notifications.js";
import { confirmHeldStayIfPaid, expireLapsedHolds, refreshReservationPayment } from "../payments/ledger.js";
import { OCCUPYING_STAY_SQL, assertMinimumStay, insertGuest, staffReference, validateStay } from "../public/booking.service.js";

export type ReservationRow = {
  id: string;
  reference: string;
  guest_name: string;
  email: string | null;
  phone: string | null;
  room_id: string | null;
  room_type: string;
  room_number: string | null;
  check_in: string;
  check_out: string;
  guests_count: number;
  amount_kobo: string;
  paid_kobo: string;
  status: string;
  payment_status: string;
  source: string;
  notes: string | null;
  created_at: Date;
  cursor_created: string;
};

/** Columns shared by every reservation read; `cursor_created` keeps microsecond precision for keyset paging. */
export const RESERVATION_SELECT = `
  SELECT r.id, r.reference, g.full_name AS guest_name, g.email, g.phone, r.room_id, coalesce(ro.room_type, r.room_type) AS room_type,
         ro.room_number, r.check_in::text, r.check_out::text, r.guests_count, r.amount_kobo::text,
         coalesce(paid.total, 0)::text AS paid_kobo, r.status, r.payment_status, r.source, r.notes, r.created_at, r.created_at::text AS cursor_created
    FROM reservations r
    JOIN guests g ON g.id = r.guest_id
    LEFT JOIN rooms ro ON ro.id = r.room_id
    LEFT JOIN LATERAL (SELECT sum(p.amount_kobo) AS total FROM payments p WHERE p.reservation_id = r.id AND p.status = 'settled') paid ON true`;

const MAX_RANGE_DAYS = 366;

/** Adds the caller-specific actions every client renders instead of re-deriving the rules. */
export function withActions<T extends { status: string; payment_status: string; check_in: string }>(rows: T[], role: Role) {
  const writer = hasPermission(role, "reservations:write");
  const today = businessToday();
  return rows.map((row) => ({
    ...row,
    actions: {
      next_statuses: writer ? (TRANSITIONS[row.status] ?? []).filter((next) => !((next === "checked_in" || next === "no_show") && row.check_in > today)) : [],
      record_payment: writer && !CLOSED_STAYS.has(row.status) && (row.payment_status === "unpaid" || row.payment_status === "part_paid"),
      edit: writer ? editScope(row.status) : ("none" as const),
    },
  }));
}

type EditScope = "full" | "stay_end" | "contact" | "none";

/** What staff may change on a reservation in this state (see updateReservationDetails). */
function editScope(status: string): EditScope {
  if (status === "confirmed") return "full";
  if (status === "checked_in") return "stay_end";
  // Online checkout is priced and in progress; only the guest's details can be corrected.
  if (status === "pending_payment" || status === "hold") return "contact";
  return "none";
}

function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

export async function listReservations(
  app: FastifyInstance,
  principal: Principal,
  filters: { status?: string[]; from?: string; to?: string; q?: string; limit: number; cursor?: string },
) {
  if (filters.from && filters.to) {
    const span = nightsBetween(filters.from, filters.to);
    if (span < 1 || span > MAX_RANGE_DAYS) throw Errors.unprocessable(`"to" must be after "from" and at most ${MAX_RANGE_DAYS} days later`, "INVALID_RANGE");
  }
  const cursor = decodeCursor(filters.cursor, 3);
  const rows = await withConnection(app.db, (sql) =>
    sql.rows<ReservationRow>(
      `${RESERVATION_SELECT}
        WHERE r.property_id = $1
          AND ($2::text[] IS NULL OR r.status = ANY($2::text[]))
          AND ($3::date IS NULL OR r.check_out > $3::date)
          AND ($4::date IS NULL OR r.check_in < $4::date)
          AND ($5::text IS NULL OR g.full_name ILIKE $5 ESCAPE '\\' OR r.reference ILIKE $5 ESCAPE '\\')
          AND ($6::date IS NULL OR (r.check_in, r.created_at, r.id) < ($6::date, $7::timestamptz, $8::uuid))
        ORDER BY r.check_in DESC, r.created_at DESC, r.id DESC
        LIMIT $9`,
      [
        principal.propertyId,
        filters.status?.length ? filters.status : null,
        filters.from ?? null,
        filters.to ?? null,
        filters.q ? likePattern(filters.q.trim()) : null,
        cursor?.[0] ?? null,
        cursor?.[1] ?? null,
        cursor?.[2] ?? null,
        filters.limit + 1,
      ],
    ),
  );
  const page = toPage(rows, filters.limit, (row) => [row.check_in, row.cursor_created, row.id]);
  return { reservations: withActions(page.items, principal.role), nextCursor: page.nextCursor };
}

export async function getReservation(sql: Sql, principal: Principal, id: string) {
  const row = await sql.maybeOne<ReservationRow>(`${RESERVATION_SELECT} WHERE r.id = $1 AND r.property_id = $2`, [id, principal.propertyId]);
  if (!row) throw Errors.notFound("Reservation not found");
  return withActions([row], principal.role)[0]!;
}

/** Staff booking for a specific physical room (PRD §4.2). */
export async function createStaffReservation(
  app: FastifyInstance,
  principal: Principal,
  input: { name: string; email: string | null; phone: string | null; roomId: string; checkIn: string; checkOut: string; guests: number; notes: string | null },
): Promise<ReturnType<typeof withActions<ReservationRow>>[number]> {
  const stay = validateStay(await app.settings.current(), input.checkIn, input.checkOut);
  return withTransaction(app.db, async (tx) => {
    const room = await tx.maybeOne<{ id: string; room_type: string; nightly_rate_kobo: string; status: string; capacity: number }>(
      `SELECT id, room_type, nightly_rate_kobo::text, status, capacity FROM rooms
        WHERE id = $1 AND property_id = $2 AND active FOR UPDATE`,
      [input.roomId, principal.propertyId],
    );
    if (!room) throw Errors.notFound("Room not found");
    if (room.status === "maintenance" || room.status === "out_of_order") throw Errors.conflict("The room is out of service", "ROOM_OUT_OF_SERVICE");
    if (room.capacity < input.guests) throw Errors.conflict("The selected room cannot accommodate that many guests", "ROOM_CAPACITY");
    await assertMinimumStay(tx, room.id, stay.nights);
    await expireLapsedHolds(tx, { roomId: room.id, limit: 100 });
    const clash = await tx.maybeOne(
      `SELECT 1 FROM reservations r WHERE r.room_id = $1 AND ${OCCUPYING_STAY_SQL} AND r.check_in < $3::date AND r.check_out > $2::date LIMIT 1`,
      [room.id, stay.checkIn, stay.checkOut],
    );
    if (clash) throw Errors.conflict("The room is not available for those dates", "ROOM_UNAVAILABLE");

    const amount = BigInt(room.nightly_rate_kobo) * BigInt(stay.nights);
    const guestId = await insertGuest(tx, principal.propertyId, { name: input.name, email: input.email, phone: input.phone });
    const reference = staffReference();
    const created = await tx.one<{ id: string }>(
      `INSERT INTO reservations(property_id, guest_id, reference, room_id, room_type, check_in, check_out, guests_count,
                                amount_kobo, status, source, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', 'staff', $10, $11)
       RETURNING id`,
      [principal.propertyId, guestId, reference, room.id, room.room_type, stay.checkIn, stay.checkOut, input.guests, amount.toString(), input.notes, principal.userId],
    );
    await recordEvent(tx, {
      propertyId: principal.propertyId,
      actorId: principal.userId,
      action: "reservation.created",
      entityType: "reservation",
      entityId: created.id,
      details: { roomId: room.id, amountKobo: amount.toString(), source: "staff" },
      outbox: { reference },
    });
    await notifyGuestStay(tx, created.id, "guest.booking_confirmed");
    return getReservation(tx, principal, created.id);
  });
}

type NextStatus = "checked_in" | "checked_out" | "cancelled" | "no_show";

const GUEST_STATUS_EMAIL = {
  checked_in: "guest.checked_in",
  checked_out: "guest.checked_out",
  cancelled: "guest.cancelled",
  no_show: "guest.no_show",
} as const satisfies Record<NextStatus, string>;

const TRANSITIONS: Readonly<Record<string, readonly NextStatus[]>> = {
  confirmed: ["checked_in", "cancelled", "no_show"],
  checked_in: ["checked_out"],
  pending_payment: ["cancelled"],
};

export async function changeReservationStatus(app: FastifyInstance, principal: Principal, id: string, next: NextStatus, reasonInput: string | undefined) {
  const reason = reasonInput?.trim() ?? "";
  if ((next === "cancelled" || next === "no_show") && reason.length < 3) throw Errors.unprocessable("Give a reason for this change", "REASON_REQUIRED");
  return withTransaction(app.db, async (tx) => {
    const reservation = await tx.maybeOne<{ status: string; room_id: string | null; reference: string; check_in: string }>(
      `SELECT status, room_id, reference, check_in::text FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, principal.propertyId],
    );
    if (!reservation) throw Errors.notFound("Reservation not found");
    if (!TRANSITIONS[reservation.status]?.includes(next)) {
      throw Errors.conflict(`A ${reservation.status.replaceAll("_", " ")} reservation cannot be marked ${next.replaceAll("_", " ")}`, "INVALID_TRANSITION");
    }
    if ((next === "checked_in" || next === "no_show") && reservation.check_in > businessToday()) {
      throw Errors.conflict("The arrival date has not been reached", "ARRIVAL_NOT_DUE");
    }

    const roomState = next === "checked_in" ? "occupied" : next === "checked_out" ? "vacant_dirty" : null;
    const room =
      reservation.room_id && roomState
        ? await tx.one<{ status: string; room_number: string }>(`SELECT status, room_number FROM rooms WHERE id = $1 FOR UPDATE`, [reservation.room_id])
        : null;
    if (room && next === "checked_in" && room.status !== "vacant_clean" && room.status !== "inspected") {
      throw Errors.conflict(`Room ${room.room_number} is ${room.status.replaceAll("_", " ")}; it must be clean or inspected before check-in`, "ROOM_NOT_READY");
    }

    await tx.exec(`UPDATE reservations SET status = $2, hold_expires_at = NULL, updated_at = now() WHERE id = $1`, [id, next]);
    if (room && reservation.room_id && roomState) {
      await tx.exec(`UPDATE rooms SET status = $2 WHERE id = $1`, [reservation.room_id, roomState]);
      if (roomState === "vacant_dirty") {
        await tx.exec(`INSERT INTO housekeeping_tasks(property_id, room_id, task_type, status) VALUES ($1, $2, 'turnover', 'pending')`, [principal.propertyId, reservation.room_id]);
      }
      await recordEvent(tx, {
        propertyId: principal.propertyId,
        actorId: principal.userId,
        action: "room.status_changed",
        entityType: "room",
        entityId: reservation.room_id,
        details: { from: room.status, to: roomState, note: `Guest ${next.replace("_", " ")} (${reservation.reference})` },
        outbox: { reference: `Room ${room.room_number}` },
      });
    }
    if (next === "cancelled") {
      // Unfinished online checkouts end; pending bank transfers stay for owner verification (no refunds).
      await tx.exec(`UPDATE payments SET status = 'failed' WHERE reservation_id = $1 AND method = 'online' AND status = 'pending'`, [id]);
      await refreshReservationPayment(tx, id);
    }
    await recordEvent(tx, {
      propertyId: principal.propertyId,
      actorId: principal.userId,
      action: `reservation.${next}`,
      entityType: "reservation",
      entityId: id,
      details: { from: reservation.status, to: next, reason: reason || null },
      outbox: { type: "reservation.status_changed", reference: reservation.reference },
    });
    await notifyGuestStay(tx, id, GUEST_STATUS_EMAIL[next]);
    return { reservation: { id, status: next } };
  });
}

const CLOSED_STAYS = new Set(["cancelled", "checked_out", "no_show", "expired"]);

/** Staff-recorded payment (PRD §4.2). Settled for cash/POS, pending for bank transfer. */
export async function recordStaffPayment(
  app: FastifyInstance,
  principal: Principal,
  reservationId: string,
  input: { amountKobo: number; method: "cash" | "pos" | "bank_transfer"; paymentReference: string | null; idempotencyKey: string },
) {
  if (input.method === "bank_transfer" && !input.paymentReference) throw Errors.unprocessable("Enter the sender name or bank transfer reference", "TRANSFER_REFERENCE_REQUIRED");
  const key = `staff:${input.idempotencyKey}`;
  return withTransaction(app.db, async (tx) => {
    const reservation = await tx.maybeOne<{ amount_kobo: string; status: string; reference: string }>(
      `SELECT amount_kobo::text, status, reference FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [reservationId, principal.propertyId],
    );
    if (!reservation) throw Errors.notFound("Reservation not found");

    const prior = await tx.maybeOne<{ id: string; reservation_id: string | null; status: "pending" | "settled"; amount_kobo: string; method: string }>(
      `SELECT id, reservation_id, status, amount_kobo::text, method FROM payments WHERE property_id = $1 AND idempotency_key = $2`,
      [principal.propertyId, key],
    );
    if (prior) {
      if (prior.reservation_id !== reservationId || BigInt(prior.amount_kobo) !== BigInt(input.amountKobo) || prior.method !== input.method) {
        throw Errors.conflict("This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
      }
      const state = await tx.one<{ payment_status: string }>(`SELECT payment_status FROM reservations WHERE id = $1`, [reservationId]);
      return { created: false, payment: { id: prior.id, duplicate: true, paid: state.payment_status === "paid", paymentStatus: prior.status } };
    }
    if (CLOSED_STAYS.has(reservation.status)) throw Errors.conflict("Cannot add a payment to a closed stay", "STAY_CLOSED");

    const totals = await tx.one<{ committed: string }>(
      // Settled money plus pending staff transfers; unfinished online checkouts do not count.
      `SELECT coalesce(sum(amount_kobo) FILTER (WHERE status = 'settled' OR (status = 'pending' AND method <> 'online')), 0)::text AS committed
         FROM payments WHERE reservation_id = $1`,
      [reservationId],
    );
    if (BigInt(totals.committed) + BigInt(input.amountKobo) > BigInt(reservation.amount_kobo)) {
      throw Errors.conflict("Payment exceeds the remaining balance", "OVERPAYMENT");
    }
    const status: "pending" | "settled" = input.method === "bank_transfer" ? "pending" : "settled";
    const payment = await tx.one<{ id: string }>(
      `INSERT INTO payments(property_id, reservation_id, amount_kobo, method, status, provider_reference, idempotency_key, recorded_by, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $5 = 'settled' THEN now() END)
       RETURNING id`,
      [principal.propertyId, reservationId, input.amountKobo, input.method, status, input.paymentReference, key, principal.userId],
    );
    const paymentStatus = await refreshReservationPayment(tx, reservationId);
    if (paymentStatus === "paid") await confirmHeldStayIfPaid(tx, reservationId, principal.propertyId, reservation.reference);
    await recordEvent(tx, {
      propertyId: principal.propertyId,
      actorId: principal.userId,
      action: status === "pending" ? "payment.submitted_for_confirmation" : "payment.recorded",
      entityType: "payment",
      entityId: payment.id,
      details: { reservationId, amountKobo: input.amountKobo, method: input.method, paymentReference: input.paymentReference },
      outbox: { type: status === "pending" ? "payment.pending_confirmation" : "payment.settled", reference: reservation.reference },
    });
    await notifyGuestPayment(tx, payment.id);
    if (status === "pending") {
      const guest = await tx.one<{ full_name: string }>(`SELECT g.full_name FROM reservations r JOIN guests g ON g.id = r.guest_id WHERE r.id = $1`, [reservationId]);
      await alertTransferPending(tx, {
        propertyId: principal.propertyId,
        source: "accommodation",
        entityId: payment.id,
        reference: reservation.reference,
        amountKobo: String(input.amountKobo),
        senderReference: input.paymentReference,
        recordedBy: principal.fullName,
        guestName: guest.full_name,
      });
    }
    return { created: true, payment: { id: payment.id, duplicate: false, paid: paymentStatus === "paid", paymentStatus: status } };
  });
}

export type ReservationDetailsInput = {
  name?: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  guests?: number;
  roomId?: string;
  checkIn?: string;
  checkOut?: string;
};

/**
 * Corrects a reservation. Guest details can change on any open stay; the
 * room, dates and guest count only on confirmed stays (an in-house stay may
 * change its check-out and guest count). A stay that moves is re-checked for
 * availability and re-priced, and its payment status recalculated.
 */
export async function updateReservationDetails(app: FastifyInstance, principal: Principal, id: string, input: ReservationDetailsInput) {
  const name = input.name?.trim();
  if (name === "") throw Errors.unprocessable("Enter the guest's name", "VALIDATION_FAILED");
  const rules = await app.settings.current();
  return withTransaction(app.db, async (tx) => {
    const current = await tx.maybeOne<{
      status: string;
      reference: string;
      guest_id: string;
      room_id: string | null;
      check_in: string;
      check_out: string;
      guests_count: number;
      amount_kobo: string;
    }>(
      `SELECT status, reference, guest_id, room_id, check_in::text, check_out::text, guests_count, amount_kobo::text
         FROM reservations WHERE id = $1 AND property_id = $2 FOR UPDATE`,
      [id, principal.propertyId],
    );
    if (!current) throw Errors.notFound("Reservation not found");
    const scope = editScope(current.status);
    if (scope === "none") throw Errors.conflict(`A ${current.status.replaceAll("_", " ")} reservation can no longer be changed`, "RESERVATION_CLOSED");

    const roomId = input.roomId ?? current.room_id;
    const checkIn = input.checkIn ?? current.check_in;
    const checkOut = input.checkOut ?? current.check_out;
    const guests = input.guests ?? current.guests_count;
    const moved = roomId !== current.room_id || checkIn !== current.check_in || checkOut !== current.check_out;
    if (scope === "contact" && (moved || guests !== current.guests_count)) {
      throw Errors.conflict("This booking is awaiting online payment; only the guest's details can change", "RESERVATION_IN_CHECKOUT");
    }
    if (scope === "stay_end" && (roomId !== current.room_id || checkIn !== current.check_in)) {
      throw Errors.conflict("The guest is checked in; only the check-out date and guest count can change", "GUEST_IN_HOUSE");
    }

    let amount = BigInt(current.amount_kobo);
    if (moved || guests !== current.guests_count) {
      if (!roomId) throw Errors.conflict("Assign a room first", "ROOM_REQUIRED");
      const nights = nightsBetween(checkIn, checkOut);
      if (scope === "stay_end") {
        if (nights < 1 || nights > rules.maxStayNights) throw Errors.unprocessable(`Choose a stay of 1 to ${rules.maxStayNights} nights`, "INVALID_STAY");
        if (checkOut < businessToday()) throw Errors.unprocessable("Check-out cannot be in the past", "INVALID_STAY");
      } else if (moved) {
        validateStay(rules, checkIn, checkOut);
      }
      const room = await tx.maybeOne<{ id: string; room_type: string; nightly_rate_kobo: string; status: string; capacity: number; active: boolean }>(
        `SELECT id, room_type, nightly_rate_kobo::text, status, capacity, active FROM rooms WHERE id = $1 AND property_id = $2 FOR UPDATE`,
        [roomId, principal.propertyId],
      );
      if (!room) throw Errors.notFound("Room not found");
      if (room.capacity < guests) throw Errors.conflict("The room cannot accommodate that many guests", "ROOM_CAPACITY");
      if (roomId !== current.room_id) {
        if (!room.active) throw Errors.conflict("That room is not in use", "ROOM_INACTIVE");
        if (room.status === "maintenance" || room.status === "out_of_order") throw Errors.conflict("The room is out of service", "ROOM_OUT_OF_SERVICE");
      }
      if (moved) {
        await assertMinimumStay(tx, room.id, nights);
        await expireLapsedHolds(tx, { roomId: room.id, limit: 100 });
        const clash = await tx.maybeOne(
          `SELECT 1 FROM reservations r WHERE r.room_id = $1 AND r.id <> $4 AND ${OCCUPYING_STAY_SQL} AND r.check_in < $3::date AND r.check_out > $2::date LIMIT 1`,
          [room.id, checkIn, checkOut, id],
        );
        if (clash) throw Errors.conflict("The room is not available for those dates", "ROOM_UNAVAILABLE");
        // Same room: keep the nightly price agreed at booking. Another room: its current rate.
        const oldNights = BigInt(nightsBetween(current.check_in, current.check_out));
        const nightly = roomId === current.room_id ? BigInt(current.amount_kobo) / oldNights : BigInt(room.nightly_rate_kobo);
        amount = nightly * BigInt(nights);
        const settled = await tx.one<{ committed: string }>(
          `SELECT coalesce(sum(amount_kobo) FILTER (WHERE status = 'settled' OR (status = 'pending' AND method <> 'online')), 0)::text AS committed FROM payments WHERE reservation_id = $1`,
          [id],
        );
        if (BigInt(settled.committed) > amount) throw Errors.conflict("Payments already exceed the new stay total. Shortening is not possible without a refund.", "OVERPAID");
      }
      await tx.exec(
        `UPDATE reservations SET room_id = $2, room_type = $3, check_in = $4, check_out = $5, guests_count = $6, amount_kobo = $7, updated_at = now() WHERE id = $1`,
        [id, room.id, room.room_type, checkIn, checkOut, guests, amount.toString()],
      );
      await refreshReservationPayment(tx, id);
    }

    const nullable = (value: string | null | undefined) => (value === undefined ? undefined : optionalTextOf(value));
    const email = input.email === undefined ? undefined : (optionalTextOf(input.email)?.toLowerCase() ?? null);
    const phone = nullable(input.phone);
    const notes = nullable(input.notes);
    if (name !== undefined || email !== undefined || phone !== undefined) {
      await tx.exec(
        `UPDATE guests SET full_name = coalesce($2, full_name), email = CASE WHEN $3 THEN $4 ELSE email END, phone = CASE WHEN $5 THEN $6 ELSE phone END WHERE id = $1`,
        [current.guest_id, name ?? null, email !== undefined, email ?? null, phone !== undefined, phone ?? null],
      );
    }
    if (notes !== undefined) await tx.exec(`UPDATE reservations SET notes = $2, updated_at = now() WHERE id = $1`, [id, notes]);

    await recordEvent(tx, {
      propertyId: principal.propertyId,
      actorId: principal.userId,
      action: "reservation.updated",
      entityType: "reservation",
      entityId: id,
      details: {
        ...(moved ? { from: { roomId: current.room_id, checkIn: current.check_in, checkOut: current.check_out }, to: { roomId, checkIn, checkOut } } : {}),
        ...(guests !== current.guests_count ? { guests } : {}),
        ...(amount !== BigInt(current.amount_kobo) ? { amountKobo: { from: current.amount_kobo, to: amount.toString() } } : {}),
        guestDetailsChanged: name !== undefined || email !== undefined || phone !== undefined,
        notesChanged: notes !== undefined,
      },
      outbox: { type: "reservation.updated", reference: current.reference },
    });
    return { reservation: await getReservation(tx, principal, id) };
  });
}

function optionalTextOf(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export async function listReservationPayments(app: FastifyInstance, principal: Principal, id: string) {
  return withConnection(app.db, async (sql) => {
    const exists = await sql.maybeOne(`SELECT 1 FROM reservations WHERE id = $1 AND property_id = $2`, [id, principal.propertyId]);
    if (!exists) throw Errors.notFound("Reservation not found");
    const payments = await sql.rows<{ id: string; amount_kobo: string; method: string; status: string; reference: string | null; recorded_by: string | null; created_at: Date; settled_at: Date | null }>(
      `SELECT p.id, p.amount_kobo::text, p.method, p.status, p.provider_reference AS reference, u.full_name AS recorded_by, p.created_at, p.settled_at
         FROM payments p LEFT JOIN users u ON u.id = p.recorded_by
        WHERE p.reservation_id = $1 ORDER BY p.created_at`,
      [id],
    );
    return { payments };
  });
}
