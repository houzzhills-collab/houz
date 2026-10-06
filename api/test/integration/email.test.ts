import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { App } from "../../src/app.js";
import { FakeResend, RESEND_TEST_KEY } from "../fakes/resend.js";
import { CRON_SECRET, createTestApp, integration, lagosDate, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";
const SETTINGS = `${M}/settings`;
const SENDER = "Houzz Hills <bookings@houzzhills.test>";

type Row = { template: string; audience: string; recipient_email: string; status: string; payload: unknown; sealed_payload: string | null; attempts: number; last_error: string | null };

describe.skipIf(!integration)("transactional email", () => {
  const databaseUrl = inject("emailDatabaseUrl") ?? "";
  const resend = new FakeResend();
  let app: App;
  let propertyId: string;
  let owner: Awaited<ReturnType<typeof signedIn>>;
  let manager: Awaited<ReturnType<typeof signedIn>>;
  let desk: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    app = await createTestApp({ DATABASE_URL: databaseUrl, RESEND_BASE_URL: await resend.start() });
    propertyId = await seedProperty(app);
    [owner, manager, desk] = await Promise.all([signedIn(app, propertyId, "owner"), signedIn(app, propertyId, "manager"), signedIn(app, propertyId, "front_desk")]);
  });
  afterAll(async () => {
    await app?.close();
    await resend.stop();
  });
  beforeEach(() => resend.reset());

  const change = (changes: Record<string, unknown>) => app.inject({ method: "PATCH", url: SETTINGS, headers: owner.headers, payload: { changes } });
  const rows = (where = "true", params: unknown[] = []): Promise<Row[]> =>
    app.db.query(`SELECT template, audience, recipient_email, status, payload, sealed_payload, attempts, last_error FROM email_messages WHERE ${where} ORDER BY created_at, id`, params);
  /** Delivers everything due, as the background dispatcher would. */
  const drain = async () => {
    for (let round = 0; round < 20; round += 1) {
      const report = await app.email.dispatchDue();
      if (report.sent + report.retrying + report.failed + report.skipped === 0) return;
    }
  };
  const enableEmail = async () => {
    const response = await change({ "email.resend_api_key": RESEND_TEST_KEY, "email.from_address": SENDER, "email.reply_to": "frontdesk@houzzhills.test", "email.provider": "resend" });
    expect(response.statusCode).toBe(200);
  };

  it("validates email settings, keeps the key write-only and sends a test email before delivery is switched on", async () => {
    expect((await change({ "email.provider": "resend" })).json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
    expect((await change({ "email.resend_api_key": "sk_live_nope" })).json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await change({ "email.from_address": "not an address" })).json()).toMatchObject({ code: "VALIDATION_FAILED" });
    expect((await app.inject({ method: "POST", url: `${SETTINGS}/email/test`, headers: owner.headers })).json()).toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });

    const saved = await change({ "email.resend_api_key": RESEND_TEST_KEY, "email.from_address": SENDER });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(RESEND_TEST_KEY);
    const stored = await app.db.query("SELECT value FROM settings WHERE key = 'email.resend_api_key'");
    expect(stored[0].value).toMatch(/^v1\./);

    const test = await app.inject({ method: "POST", url: `${SETTINGS}/email/test`, headers: owner.headers });
    expect(test.json()).toMatchObject({ ok: true, to: owner.user.email });
    const [email] = resend.to(owner.user.email);
    expect(email).toMatchObject({ from: SENDER, subject: expect.stringContaining("Test email") });
    expect(email?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(email?.text).toContain("Your email settings work");

    resend.failNext = [422];
    expect((await app.inject({ method: "POST", url: `${SETTINGS}/email/test`, headers: owner.headers })).json()).toMatchObject({ code: "EMAIL_REJECTED", message: expect.stringContaining("not verified") });

    const log = await app.inject({ url: `${SETTINGS}/email/messages`, headers: owner.headers });
    expect(log.json<{ messages: Array<{ status: string }> }>().messages.slice(0, 2).map((message) => message.status)).toEqual(["failed", "sent"]);
    expect((await app.inject({ url: `${SETTINGS}/email/messages`, headers: manager.headers })).statusCode).toBe(403);
  });

  it("skips queued mail while delivery is off, and alerts owners about sensitive settings changes", async () => {
    // Saving the key above queued a security notice; email was still off, so it is skipped rather than sent late.
    await drain();
    expect(await rows("template = 'alert.settings_changed' AND status = 'skipped'")).not.toHaveLength(0);

    await enableEmail();
    await drain();
    const [notice] = resend.to(owner.user.email);
    expect(notice?.subject).toBe("Security notice: settings changed");
    expect(notice?.text).toContain("Resend API key replaced");
    expect(notice?.html).not.toContain(RESEND_TEST_KEY);
    expect(notice?.reply_to).toBe("frontdesk@houzzhills.test");
    // Managers are not owners: no security notice for them.
    expect(resend.to(manager.user.email)).toHaveLength(0);
  });

  it("emails new staff their temporary password, sealed in the outbox and dropped after sending", async () => {
    const email = `new-${randomUUID().slice(0, 8)}@houzzhills.test`;
    const created = await app.inject({
      method: "POST",
      url: `${M}/staff`,
      headers: manager.headers,
      payload: { fullName: "Ada Cashier", email, employeeNumber: `E-${randomUUID().slice(0, 6)}`, department: "Restaurant", jobTitle: "Cashier", role: "restaurant_cashier" },
    });
    expect(created.statusCode).toBe(201);
    const password = created.json<{ staff: { temporaryPassword: string } }>().staff.temporaryPassword;

    const [queued] = await rows("recipient_email = $1", [email]);
    expect(queued).toMatchObject({ template: "staff.welcome", audience: "staff", status: "queued" });
    expect(queued?.sealed_payload).toMatch(/^v1\./);
    expect(JSON.stringify(queued?.payload)).not.toContain(password);

    await drain();
    const [welcome] = resend.to(email);
    expect(welcome?.subject).toContain("staff account");
    expect(welcome?.html).toContain(password);
    expect(welcome?.text).toContain("Restaurant cashier");
    expect(await rows("recipient_email = $1", [email])).toMatchObject([{ status: "sent", payload: null, sealed_payload: null }]);
  });

  it("follows a guest stay from confirmation through payment to check-in, and alerts confirmers about transfers", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 2_500_000, roomNumber: `R${randomUUID().slice(0, 4)}` });
    const guestEmail = `guest-${randomUUID().slice(0, 8)}@example.com`;
    const created = await app.inject({
      method: "POST",
      url: `${M}/reservations`,
      headers: desk.headers,
      payload: { name: "Tolu <b>Adeyemi</b>", email: guestEmail, roomId: room.id, checkIn: lagosDate(0), checkOut: lagosDate(2), guests: 1 },
    });
    expect(created.statusCode).toBe(201);
    const reservation = created.json<{ reservation: { id: string; reference: string } }>().reservation;
    const pay = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `${M}/reservations/${reservation.id}/payments`, headers: { ...desk.headers, "idempotency-key": randomUUID() }, payload });

    expect((await pay({ amountKobo: 2_000_000, method: "cash" })).statusCode).toBe(201);
    expect((await pay({ amountKobo: 3_000_000, method: "bank_transfer", paymentReference: "TRF-889" })).statusCode).toBe(201);
    expect((await app.inject({ method: "PATCH", url: `${M}/reservations/${reservation.id}`, headers: desk.headers, payload: { status: "checked_in" } })).statusCode).toBe(200);
    await drain();

    const guest = resend.to(guestEmail);
    expect(guest.map((email) => email.tags.find((tag) => tag.name === "template")?.value)).toEqual([
      "guest_booking_confirmed",
      "guest_payment_received",
      "guest_transfer_pending",
      "guest_checked_in",
    ]);
    const [confirmed, receipt] = guest;
    expect(confirmed?.subject).toContain(reservation.reference);
    expect(confirmed?.text).toContain("₦50,000.00");
    expect(confirmed?.text).toContain(`Room ${room.roomNumber}`);
    // Guest-supplied text is escaped, never rendered as markup.
    expect(confirmed?.html).toContain("Tolu &lt;b&gt;Adeyemi&lt;/b&gt;");
    expect(confirmed?.html).not.toContain("<b>Adeyemi</b>");
    expect(receipt?.subject).toContain("₦20,000.00");
    expect(receipt?.text).toContain("Balance due");

    // Owner and manager hold payments:confirm; front desk does not.
    for (const person of [owner, manager]) {
      expect(resend.to(person.user.email).map((email) => email.subject)).toContain(`Confirm bank transfer · ₦30,000.00 · ${reservation.reference}`);
    }
    expect(resend.to(desk.user.email)).toHaveLength(0);
  });

  it("respects the audience switches", async () => {
    expect((await change({ "email.guest_notifications": "off" })).statusCode).toBe(200);
    const room = await seedRoom(app, propertyId);
    const guestEmail = `quiet-${randomUUID().slice(0, 8)}@example.com`;
    const created = await app.inject({
      method: "POST",
      url: `${M}/reservations`,
      headers: desk.headers,
      payload: { name: "Quiet Guest", email: guestEmail, roomId: room.id, checkIn: lagosDate(3), checkOut: lagosDate(4), guests: 1 },
    });
    expect(created.statusCode).toBe(201);
    await drain();
    expect(resend.to(guestEmail)).toHaveLength(0);
    expect(await rows("recipient_email = $1", [guestEmail])).toMatchObject([{ status: "skipped", last_error: "Guest emails are turned off", payload: null }]);
    expect((await change({ "email.guest_notifications": "on" })).statusCode).toBe(200);
  });

  it("retries transient Resend failures with backoff and gives up on permanent ones without double-sending", async () => {
    const book = async (email: string) => {
      const room = await seedRoom(app, propertyId);
      return app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Retry Guest", email, roomId: room.id, checkIn: lagosDate(10), checkOut: lagosDate(11), guests: 1 } });
    };

    const transient = `transient-${randomUUID().slice(0, 8)}@example.com`;
    expect((await book(transient)).statusCode).toBe(201);
    resend.failNext = [500];
    await app.email.dispatchDue();
    const [retrying] = await rows("recipient_email = $1", [transient]);
    expect(retrying).toMatchObject({ status: "queued", attempts: 1, last_error: expect.stringContaining("500") });
    // Not due yet: backoff holds it back.
    await app.email.dispatchDue();
    expect(resend.to(transient)).toHaveLength(0);
    await app.db.query("UPDATE email_messages SET next_attempt_at = now() WHERE recipient_email = $1", [transient]);
    await drain();
    expect(resend.to(transient)).toHaveLength(1);
    expect(await rows("recipient_email = $1", [transient])).toMatchObject([{ status: "sent", attempts: 2 }]);

    const permanent = `permanent-${randomUUID().slice(0, 8)}@example.com`;
    expect((await book(permanent)).statusCode).toBe(201);
    resend.failNext = [422];
    await drain();
    expect(await rows("recipient_email = $1", [permanent])).toMatchObject([{ status: "failed", attempts: 1, payload: null }]);
  });

  it("alerts on low stock only when an item crosses its reorder level", async () => {
    const storekeeper = await signedIn(app, propertyId, "storekeeper");
    const item = await app.inject({ method: "POST", url: `${M}/inventory/items`, headers: storekeeper.headers, payload: { name: "Basmati rice", unit: "kg", quantity: 10, reorderLevel: 4 } });
    const itemId = item.json<{ item: { id: string } }>().item.id;
    const waste = (quantity: number) => app.inject({ method: "POST", url: `${M}/inventory/movements`, headers: storekeeper.headers, payload: { action: "wastage", itemId, quantity, reason: "Spoiled" } });

    expect((await waste(3)).statusCode).toBe(200); // 7 left: above the level
    expect((await waste(4)).statusCode).toBe(200); // 3 left: crosses
    expect((await waste(1)).statusCode).toBe(200); // 2 left: already low, no repeat
    await drain();
    const alerts = resend.to(storekeeper.user.email);
    expect(alerts.map((email) => email.subject)).toEqual(["Low stock: Basmati rice"]);
    expect(alerts[0]?.text).toContain("3 kg");
  });

  it("queues the daily summary once per owner and manager per day", async () => {
    const run = () => app.inject({ method: "POST", url: "/api/v1/cron/daily-summary", headers: { authorization: `Bearer ${CRON_SECRET}` } });
    const first = await run();
    expect(first.json<{ queued: number }>().queued).toBeGreaterThanOrEqual(2);
    expect((await run()).json()).toMatchObject({ queued: 0 });
    await drain();
    const [summary] = resend.to(manager.user.email);
    expect(summary?.subject).toMatch(/^Daily summary · /);
    expect(summary?.text).toContain("Arrivals");
    expect(resend.to(desk.user.email)).toHaveLength(0);
  });

  it("turns delivery off cleanly", async () => {
    expect((await change({ "email.provider": "none" })).statusCode).toBe(200);
    await drain();
    expect(resend.sent).toHaveLength(0);
    expect(await rows("status IN ('queued', 'sending')")).toHaveLength(0);
  });
});
