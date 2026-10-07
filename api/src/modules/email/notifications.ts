import type { Sql } from "../../db/sql.js";
import { queueAlert, queueEmail } from "./queue.js";
import type { GuestContact, PaymentSummary, StaySummary, TemplateName } from "./templates.js";

/**
 * Domain-level notifications, called by services inside their transactions
 * right after the change (and its audit event) is written. Each one reads what
 * its email needs from the same transaction, so the email describes exactly the
 * state being committed.
 */

type StayRow = {
  property_id: string;
  reference: string;
  source: string;
  guest_name: string;
  email: string | null;
  phone: string | null;
  room_type: string;
  room_number: string | null;
  check_in: string;
  check_out: string;
  guests_count: number;
  amount_kobo: string;
  paid_kobo: string;
  payment_status: string;
  apartment_address: string | null;
  apartment_directions: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  caution_fee_kobo: string | null;
};

async function loadStay(tx: Sql, reservationId: string): Promise<{ propertyId: string; email: string | null; contact: GuestContact; source: string; stay: StaySummary } | null> {
  const row = await tx.maybeOne<StayRow>(
    `SELECT r.property_id, r.reference, r.source, g.full_name AS guest_name, g.email, g.phone, coalesce(ro.room_type, r.room_type) AS room_type,
            ro.room_number, r.check_in::text, r.check_out::text, r.guests_count, r.amount_kobo::text,
            coalesce((SELECT sum(p.amount_kobo) FROM payments p WHERE p.reservation_id = r.id AND p.status = 'settled'), 0)::text AS paid_kobo,
            r.payment_status, nullif(concat_ws(', ', ap.address_line, ap.area, ap.city, ap.state), '') AS apartment_address,
            ap.directions AS apartment_directions, ap.check_in_time, ap.check_out_time, ap.caution_fee_kobo::text
       FROM reservations r
       JOIN guests g ON g.id = r.guest_id
       LEFT JOIN rooms ro ON ro.id = r.room_id
       LEFT JOIN apartments ap ON ap.room_id = r.room_id
      WHERE r.id = $1`,
    [reservationId],
  );
  if (!row) return null;
  return {
    propertyId: row.property_id,
    email: row.email,
    contact: { email: row.email, phone: row.phone },
    source: row.source,
    stay: {
      reference: row.reference,
      publicReference: row.source === "public_website",
      guestName: row.guest_name,
      roomType: row.room_type,
      roomNumber: row.room_number,
      checkIn: row.check_in,
      checkOut: row.check_out,
      guests: row.guests_count,
      amountKobo: row.amount_kobo,
      paidKobo: row.paid_kobo,
      paymentStatus: row.payment_status,
      apartment:
        row.check_in_time && row.check_out_time
          ? {
              address: row.apartment_address,
              directions: row.apartment_directions,
              checkInTime: row.check_in_time,
              checkOutTime: row.check_out_time,
              cautionFeeKobo: row.caution_fee_kobo ?? "0",
            }
          : null,
    },
  };
}

type StayTemplate = Extract<TemplateName, "guest.booking_confirmed" | "guest.checked_in" | "guest.checked_out" | "guest.cancelled" | "guest.no_show" | "guest.hold_expired">;

/** Emails the guest about their reservation, when they gave an email address. At most once per template and stay. */
export async function notifyGuestStay(tx: Sql, reservationId: string, template: StayTemplate): Promise<void> {
  const loaded = await loadStay(tx, reservationId);
  if (!loaded?.email) return;
  await queueEmail(tx, {
    propertyId: loaded.propertyId,
    template,
    to: { email: loaded.email, name: loaded.stay.guestName },
    data: { stay: loaded.stay },
    dedupeKey: `${template}:${reservationId}`,
  });
}

/** A held website booking became confirmed: tell the guest, and tell reservations staff about the new online booking. */
export async function notifyStayConfirmed(tx: Sql, reservationId: string): Promise<void> {
  const loaded = await loadStay(tx, reservationId);
  if (!loaded) return;
  if (loaded.email) {
    await queueEmail(tx, {
      propertyId: loaded.propertyId,
      template: "guest.booking_confirmed",
      to: { email: loaded.email, name: loaded.stay.guestName },
      data: { stay: loaded.stay },
      dedupeKey: `guest.booking_confirmed:${reservationId}`,
    });
  }
  if (loaded.source === "public_website") {
    await queueAlert(tx, {
      propertyId: loaded.propertyId,
      template: "alert.new_booking",
      data: { stay: loaded.stay },
      roles: ["owner", "manager", "front_desk"],
      dedupeKey: `alert.new_booking:${reservationId}`,
    });
  }
}

/** A website guest started checkout: tell them how to finish paying, and tell reservations staff a booking is on the way. */
export async function notifyBookingReceived(tx: Sql, reservationId: string, hold: { expiresAt: Date; checkoutUrl: string }): Promise<void> {
  const loaded = await loadStay(tx, reservationId);
  if (!loaded) return;
  const holdExpiresAt = hold.expiresAt.toISOString();
  if (loaded.email) {
    await queueEmail(tx, {
      propertyId: loaded.propertyId,
      template: "guest.booking_received",
      to: { email: loaded.email, name: loaded.stay.guestName },
      data: { stay: loaded.stay, holdExpiresAt, checkoutUrl: hold.checkoutUrl },
      dedupeKey: `guest.booking_received:${reservationId}`,
    });
  }
  await queueAlert(tx, {
    propertyId: loaded.propertyId,
    template: "alert.booking_request",
    data: { stay: loaded.stay, contact: loaded.contact, holdExpiresAt },
    roles: ["owner", "manager", "front_desk"],
    dedupeKey: `alert.booking_request:${reservationId}`,
  });
}

/** A checkout hold lapsed unpaid: tell the guest the dates were released, and tell staff about an unfinished website booking. */
export async function notifyHoldExpired(tx: Sql, reservationId: string): Promise<void> {
  await notifyGuestStay(tx, reservationId, "guest.hold_expired");
  const loaded = await loadStay(tx, reservationId);
  if (loaded?.source !== "public_website") return;
  await queueAlert(tx, {
    propertyId: loaded.propertyId,
    template: "alert.booking_expired",
    data: { stay: loaded.stay, contact: loaded.contact },
    roles: ["owner", "manager", "front_desk"],
    dedupeKey: `alert.booking_expired:${reservationId}`,
  });
}

/** Receipt for a settled payment, or a "being verified" note for a pending bank transfer. */
export async function notifyGuestPayment(tx: Sql, paymentId: string): Promise<void> {
  const payment = await tx.maybeOne<{ reservation_id: string; amount_kobo: string; method: string; status: string; provider_reference: string | null; at: Date }>(
    `SELECT reservation_id, amount_kobo::text, method, status, provider_reference, coalesce(settled_at, created_at) AS at FROM payments WHERE id = $1`,
    [paymentId],
  );
  if (!payment?.reservation_id || payment.status === "failed") return;
  const loaded = await loadStay(tx, payment.reservation_id);
  if (!loaded?.email) return;
  const template = payment.status === "settled" ? "guest.payment_received" : "guest.transfer_pending";
  const summary: PaymentSummary = {
    amountKobo: payment.amount_kobo,
    method: payment.method,
    // Online references are internal; show only what a guest gave or recognises.
    reference: payment.method === "online" ? null : payment.provider_reference,
    at: payment.at.toISOString(),
  };
  await queueEmail(tx, {
    propertyId: loaded.propertyId,
    template,
    to: { email: loaded.email, name: loaded.stay.guestName },
    data: { stay: loaded.stay, payment: summary },
    dedupeKey: `${template}:${paymentId}`,
  });
}

/** Money arrived after the hold lapsed: reassure the guest that a person will follow up. */
export async function notifyGuestLatePayment(tx: Sql, reservationId: string, paymentId: string, amountKobo: string): Promise<void> {
  const loaded = await loadStay(tx, reservationId);
  if (!loaded?.email) return;
  await queueEmail(tx, {
    propertyId: loaded.propertyId,
    template: "guest.late_payment",
    to: { email: loaded.email, name: loaded.stay.guestName },
    data: { stay: loaded.stay, amountKobo },
    dedupeKey: `guest.late_payment:${paymentId}`,
  });
}

/** Alerts everyone who can confirm payments that a bank transfer is waiting for them. */
export async function alertTransferPending(
  tx: Sql,
  input: { propertyId: string; source: "accommodation" | "restaurant"; entityId: string; reference: string; amountKobo: string; senderReference: string | null; recordedBy: string; guestName: string | null },
): Promise<void> {
  await queueAlert(tx, {
    propertyId: input.propertyId,
    template: "alert.transfer_pending",
    data: {
      source: input.source,
      reference: input.reference,
      amountKobo: input.amountKobo,
      senderReference: input.senderReference,
      recordedBy: input.recordedBy,
      guestName: input.guestName,
    },
    permission: "payments:confirm",
    dedupeKey: `alert.transfer_pending:${input.entityId}`,
  });
}

export type StockLevel = { name: string; unit: string; quantity: string; reorderLevel: string };

/** Items that just fell to or below their reorder level. */
export async function alertLowStock(tx: Sql, propertyId: string, items: readonly StockLevel[], cause: string): Promise<void> {
  if (items.length === 0) return;
  await queueAlert(tx, {
    propertyId,
    template: "alert.low_stock",
    data: { items: items.map((item) => ({ ...item, quantity: trimQuantity(item.quantity), reorderLevel: trimQuantity(item.reorderLevel) })), cause },
    permission: "inventory:write",
  });
}

/** "12.500" → "12.5", "3.000" → "3". */
function trimQuantity(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** Name of a staff member for "X did Y" lines. */
export async function staffName(tx: Sql, userId: string): Promise<string> {
  const row = await tx.maybeOne<{ full_name: string }>(`SELECT full_name FROM users WHERE id = $1`, [userId]);
  return row?.full_name ?? "A team member";
}
