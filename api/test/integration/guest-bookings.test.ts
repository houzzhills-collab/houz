import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { open } from "../../src/lib/secret-box.js";
import { sealedPayloadContext } from "../../src/modules/email/queue.js";
import { FakePaystack } from "../fakes/paystack.js";
import { createTestApp, enablePaystack, integration, lagosDate, paystackEnv, primaryPropertyId, seedRoom } from "../helpers.js";

const PUBLIC = "/api/v1/public";
const SHORT_REFERENCE = /^HH-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/;

type Booking = {
  reference: string;
  status: string;
  payLater: boolean;
  holdExpiresAt: string | null;
  canPay: boolean;
  stay: { name: string; address: string | null };
  payment: { status: string; amountKobo: string; paidKobo: string; balanceKobo: string; payments: Array<{ amountKobo: string; method: string; status: string }> };
};

describe.skipIf(!integration)("book now, pay later and guest booking access", () => {
  const paystack = new FakePaystack();
  let app: App;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp(paystackEnv(await paystack.start()));
    propertyId = await primaryPropertyId(app);
    await enablePaystack(app, propertyId);
  });
  afterAll(async () => {
    await app?.close();
    await paystack.stop();
  });

  const guestEmail = () => `guest-${randomUUID().slice(0, 8)}@example.com`;
  const book = (roomType: string, email: string, options: { payLater?: boolean; key?: string; days?: number } = {}) =>
    app.inject({
      method: "POST",
      url: `${PUBLIC}/reservations`,
      headers: { "idempotency-key": options.key ?? randomUUID() },
      payload: {
        name: "Ngozi Guest",
        email,
        roomType,
        guests: 2,
        checkIn: lagosDate(options.days ?? 20),
        checkOut: lagosDate((options.days ?? 20) + 3),
        ...(options.payLater ? { paymentOption: "pay_later" } : {}),
      },
    });
  const post = (path: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: `${PUBLIC}/bookings${path}`, payload });
  const lookup = (reference: string, email: string) => post("/lookup", { reference, email });
  const webhook = (reference: string) => {
    const { body, signature } = paystack.webhook(reference);
    return app.inject({ method: "POST", url: "/api/v1/webhooks/payments", headers: { "content-type": "application/json", "x-paystack-signature": signature }, payload: body });
  };
  const emailsTo = async (email: string, template: string) =>
    (await app.db.query("SELECT id, sealed_payload FROM email_messages WHERE recipient_email = $1 AND template = $2 ORDER BY created_at", [email, template])) as Array<{
      id: string;
      sealed_payload: string | null;
    }>;
  const latestCode = async (email: string): Promise<string> => {
    const messages = await emailsTo(email, "guest.access_code");
    const last = messages[messages.length - 1];
    if (!last?.sealed_payload) throw new Error("no access code email");
    const opened = open(app.config.settingsEncryptionKey, last.sealed_payload, sealedPayloadContext(last.id));
    return (JSON.parse(opened ?? "{}") as { code: string }).code;
  };

  it("holds a pay-later booking without checkout, with a short reference and an emailed receipt", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 4_000_000 });
    const email = guestEmail();
    const key = randomUUID();
    const response = await book(room.roomType, email, { payLater: true, key });
    expect(response.statusCode).toBe(201);
    const body = response.json<{ reservation: { reference: string; amountKobo: string; payLater: boolean; holdExpiresAt: string }; checkoutUrl: string | null }>();
    expect(body.checkoutUrl).toBeNull();
    expect(body.reservation).toMatchObject({ amountKobo: "12000000", payLater: true });
    expect(body.reservation.reference).toMatch(SHORT_REFERENCE);
    const holdHours = (Date.parse(body.reservation.holdExpiresAt) - Date.now()) / 3_600_000;
    expect(holdHours).toBeGreaterThan(23.9);
    expect(holdHours).toBeLessThanOrEqual(24);
    expect(paystack.transactions.has(body.reservation.reference)).toBe(false);

    const [row] = await app.db.query(
      "SELECT r.status, r.payment_status, r.pay_later, (SELECT count(*)::int FROM payments p WHERE p.reservation_id = r.id) AS payments FROM reservations r WHERE r.reference = $1",
      [body.reservation.reference],
    );
    expect(row).toEqual({ status: "pending_payment", payment_status: "unpaid", pay_later: true, payments: 0 });
    expect(await emailsTo(email, "guest.booking_held")).toHaveLength(1);

    // The room is taken while held, and a retry returns the same booking.
    const again = await book(room.roomType, guestEmail(), { payLater: true });
    expect(again.json()).toMatchObject({ code: "ROOM_UNAVAILABLE" });
    const retry = await book(room.roomType, email, { payLater: true, key });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toEqual(body);
  });

  it("shows a booking for its reference and email, however the reference is typed, and nothing for a wrong pair", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 4_000_000 });
    const email = guestEmail();
    const { reservation } = (await book(room.roomType, email, { payLater: true })).json<{ reservation: { reference: string } }>();

    const typed = reservation.reference.replace(/-/g, "").toLowerCase().replace(/^hh/, "");
    const found = await lookup(typed, email.toUpperCase());
    expect(found.statusCode).toBe(200);
    expect(found.headers["cache-control"]).toBe("no-store");
    expect(found.json<{ booking: Booking }>().booking).toMatchObject({
      reference: reservation.reference,
      status: "pending_payment",
      payLater: true,
      canPay: true,
      stay: { name: room.roomType, address: null },
      payment: { status: "unpaid", amountKobo: "12000000", paidKobo: "0", balanceKobo: "12000000", payments: [] },
    });

    for (const [reference, address] of [
      [reservation.reference, guestEmail()],
      ["HH-AAAA-AAAA-AA", email],
      ["nonsense", email],
    ] as const) {
      const missing = await lookup(reference, address);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: "BOOKING_NOT_FOUND" });
    }
  });

  it("lets the guest pay later through hosted checkout, which confirms the stay once", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 4_000_000 });
    const email = guestEmail();
    const { reservation } = (await book(room.roomType, email, { payLater: true })).json<{ reservation: { reference: string } }>();

    expect((await post("/checkout", { reference: reservation.reference, email: guestEmail() })).statusCode).toBe(404);
    const started = await post("/checkout", { reference: reservation.reference, email });
    expect(started.statusCode).toBe(200);
    const { checkoutUrl } = started.json<{ checkoutUrl: string }>();
    expect(checkoutUrl).toBe(`https://checkout.paystack.test/${reservation.reference}`);
    expect(paystack.transactions.get(reservation.reference)?.amount).toBe(12_000_000);
    // A second click resumes the same checkout rather than starting another.
    expect((await post("/checkout", { reference: reservation.reference, email })).json()).toEqual({ checkoutUrl });

    paystack.succeed(reservation.reference);
    expect((await webhook(reservation.reference)).statusCode).toBe(200);
    const { booking } = (await lookup(reservation.reference, email)).json<{ booking: Booking }>();
    expect(booking).toMatchObject({ status: "confirmed", canPay: false, holdExpiresAt: null, payment: { status: "paid", paidKobo: "12000000", balanceKobo: "0" } });
    expect(booking.payment.payments).toEqual([expect.objectContaining({ amountKobo: "12000000", method: "online", status: "settled" })]);
    expect((await post("/checkout", { reference: reservation.reference, email })).json()).toMatchObject({ code: "BOOKING_ALREADY_CONFIRMED" });
  });

  it("keeps the hold when checkout cannot start, and refuses payment once the hold has ended", async () => {
    const room = await seedRoom(app, propertyId);
    const email = guestEmail();
    const { reservation } = (await book(room.roomType, email, { payLater: true })).json<{ reservation: { reference: string } }>();

    paystack.failInitialize = true;
    try {
      expect((await post("/checkout", { reference: reservation.reference, email })).statusCode).toBe(502);
    } finally {
      paystack.failInitialize = false;
    }
    expect((await lookup(reservation.reference, email)).json<{ booking: Booking }>().booking).toMatchObject({ status: "pending_payment", canPay: true, payment: { status: "unpaid" } });

    await app.db.query("UPDATE reservations SET hold_expires_at = now() - interval '1 minute' WHERE reference = $1", [reservation.reference]);
    expect((await post("/checkout", { reference: reservation.reference, email })).json()).toMatchObject({ code: "BOOKING_NOT_PAYABLE" });
    expect((await lookup(reservation.reference, email)).json<{ booking: Booking }>().booking).toMatchObject({ canPay: false, holdExpiresAt: null });
  });

  it("resumes the checkout of a pay-now booking the guest left", async () => {
    const room = await seedRoom(app, propertyId);
    const email = guestEmail();
    const created = (await book(room.roomType, email)).json<{ reservation: { reference: string; payLater: boolean }; checkoutUrl: string }>();
    expect(created.reservation.payLater).toBe(false);
    expect((await post("/checkout", { reference: created.reservation.reference, email })).json()).toEqual({ checkoutUrl: created.checkoutUrl });
  });

  it("emails a one-time code that opens every booking for the address, once", async () => {
    const email = guestEmail();
    const first = await seedRoom(app, propertyId);
    const second = await seedRoom(app, propertyId);
    const a = (await book(first.roomType, email, { payLater: true, days: 40 })).json<{ reservation: { reference: string } }>().reservation.reference;
    const b = (await book(second.roomType, email.toUpperCase(), { payLater: true, days: 50 })).json<{ reservation: { reference: string } }>().reservation.reference;

    const stranger = guestEmail();
    const unknown = await post("/access-code", { email: stranger });
    expect(unknown.statusCode).toBe(202);
    expect(await emailsTo(stranger, "guest.access_code")).toHaveLength(0);

    const requested = await post("/access-code", { email });
    expect(requested.statusCode).toBe(202);
    expect(requested.json()).toEqual({ expiresMinutes: 10 });
    // A second request within the minute sends nothing new.
    expect((await post("/access-code", { email })).statusCode).toBe(202);
    expect(await emailsTo(email, "guest.access_code")).toHaveLength(1);
    const code = await latestCode(email);
    expect(code).toMatch(/^\d{6}$/);
    const [stored] = await app.db.query("SELECT payload::text FROM email_messages WHERE recipient_email = $1 AND template = 'guest.access_code'", [email]);
    expect(stored.payload).not.toContain(code);

    const wrong = code === "000000" ? "111111" : "000000";
    expect((await post("/session", { email, code: wrong })).json()).toMatchObject({ code: "INVALID_CODE" });
    const session = await post("/session", { email: email.toUpperCase(), code });
    expect(session.statusCode).toBe(200);
    const { token } = session.json<{ token: string; email: string }>();
    expect(session.json()).toMatchObject({ email });
    expect((await post("/session", { email, code })).statusCode).toBe(401);

    const list = await app.inject({ url: `${PUBLIC}/bookings`, headers: { "x-guest-session": token } });
    expect(list.statusCode).toBe(200);
    const listed = list.json<{ email: string; bookings: Booking[] }>();
    expect(listed.email).toBe(email);
    expect(listed.bookings.map((booking) => booking.reference)).toEqual([b, a]);

    expect((await app.inject({ method: "DELETE", url: `${PUBLIC}/bookings/session`, headers: { "x-guest-session": token } })).statusCode).toBe(204);
    const ended = await app.inject({ url: `${PUBLIC}/bookings`, headers: { "x-guest-session": token } });
    expect(ended.statusCode).toBe(401);
    expect(ended.json()).toMatchObject({ code: "GUEST_SESSION_EXPIRED" });
  });

  it("cancels a code after five wrong attempts", async () => {
    const email = guestEmail();
    const room = await seedRoom(app, propertyId);
    await book(room.roomType, email, { payLater: true, days: 60 });
    await post("/access-code", { email });
    const code = await latestCode(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await post("/session", { email, code: wrong })).statusCode).toBe(401);
    expect((await post("/session", { email, code: wrong })).json()).toMatchObject({ code: "TOO_MANY_CODE_ATTEMPTS" });
    expect((await post("/session", { email, code })).statusCode).toBe(401);
  });
});
