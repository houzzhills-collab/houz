import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderEmail } from "../../src/modules/email/layout.js";
import { EmailSendError, sendWithResend } from "../../src/modules/email/resend.js";
import { TEMPLATE_AUDIENCE, day, naira, renderTemplate, type StaySummary, type TemplateContext, type TemplateData, type TemplateName } from "../../src/modules/email/templates.js";
import { FakeResend, RESEND_TEST_KEY } from "../fakes/resend.js";

const ctx: TemplateContext = {
  brand: { propertyName: "Houzz Hills Kaduna", webUrl: "https://houzzhills.test" },
  recipientName: "Amina Bello",
  managementUrl: "https://houzzhills.test/management",
  bookingUrl: "https://houzzhills.test/reserve",
  statusUrl: (reference) => `https://houzzhills.test/payment-result?reference=${reference}`,
};

const stay: StaySummary = {
  reference: "HH-ABC-123",
  publicReference: true,
  guestName: "Chidi Okafor",
  roomType: "Deluxe King",
  roomNumber: "204",
  checkIn: "2026-10-06",
  checkOut: "2026-10-09",
  guests: 2,
  amountKobo: "15000000",
  paidKobo: "5000000",
  paymentStatus: "part_paid",
};
const payment = { amountKobo: "5000000", method: "pos", reference: "POS-77", at: "2026-10-06T13:05:00.000Z" };

/** Sample data for every template, so adding a template without a sample fails the type check. */
const SAMPLES: { [K in TemplateName]: TemplateData[K] } = {
  "guest.booking_received": { stay, holdExpiresAt: "2026-10-05T12:30:00.000Z", checkoutUrl: "https://checkout.paystack.test/abc" },
  "guest.booking_confirmed": { stay },
  "guest.checked_in": { stay },
  "guest.checked_out": { stay: { ...stay, paidKobo: stay.amountKobo, paymentStatus: "paid" } },
  "guest.cancelled": { stay },
  "guest.no_show": { stay },
  "guest.hold_expired": { stay },
  "guest.late_payment": { stay, amountKobo: "15000000" },
  "guest.payment_received": { stay, payment },
  "guest.transfer_pending": { stay, payment: { ...payment, method: "bank_transfer" } },
  "staff.welcome": { fullName: "Ada Obi", email: "ada@houzzhills.test", roleLabel: "Front desk", invitedBy: "Amina Bello", temporaryPassword: "Tmp-Pass-123456" },
  "staff.password_reset": { fullName: "Ada Obi", email: "ada@houzzhills.test", resetBy: "Amina Bello", temporaryPassword: "Tmp-Pass-654321" },
  "staff.password_changed": { fullName: "Ada Obi", email: "ada@houzzhills.test", at: "2026-10-06T08:00:00.000Z" },
  "staff.status_changed": { fullName: "Ada Obi", status: "on_leave", changedBy: "Amina Bello" },
  "alert.payment_exception": { kind: "amount_mismatch", reference: "HH-ABC-123", provider: "paystack", expectedKobo: "15000000", receivedKobo: "1500000", at: "2026-10-06T08:00:00.000Z" },
  "alert.transfer_pending": { source: "restaurant", reference: "R-20261006-AB12", amountKobo: "850000", senderReference: null, recordedBy: "Ada Obi", guestName: null },
  "alert.new_booking": { stay: { ...stay, paidKobo: stay.amountKobo, paymentStatus: "paid" } },
  "alert.booking_request": { stay, contact: { email: "chidi@example.test", phone: "+234 800 000 0000" }, holdExpiresAt: "2026-10-05T12:30:00.000Z" },
  "alert.booking_expired": { stay, contact: { email: "chidi@example.test", phone: null } },
  "alert.low_stock": { items: [{ name: "Rice", unit: "kg", quantity: "0", reorderLevel: "5" }, { name: "Oil", unit: "l", quantity: "2", reorderLevel: "3" }], cause: "restaurant sale R-1" },
  "alert.cash_variance": { cashier: "Ada Obi", openingFloatKobo: "1000000", expectedKobo: "4500000", countedKobo: "4400000", varianceKobo: "-100000", closedAt: "2026-10-06T20:00:00.000Z" },
  "alert.room_out_of_service": { roomNumber: "204", status: "out_of_order", note: "Leaking AC", changedBy: "Ada Obi" },
  "alert.settings_changed": { changes: ["Resend API key replaced", "Email delivery set to Resend"], changedBy: "Amina Bello", at: "2026-10-06T08:00:00.000Z" },
  "alert.daily_summary": {
    date: "2026-10-06",
    arrivals: 3,
    departures: 1,
    inHouse: 7,
    occupancyPercent: 64,
    roomsOutOfService: 1,
    newBookings: 4,
    settledYesterdayKobo: "35000000",
    accommodationYesterdayKobo: "30000000",
    restaurantYesterdayKobo: "5000000",
    pendingTransfers: 1,
    pendingTransfersKobo: "850000",
    openExceptions: 0,
    lowStockItems: 2,
  },
  "system.test": { requestedBy: "Amina Bello" },
};

describe("email formatting", () => {
  it("formats kobo as exact naira", () => {
    expect(naira("15000000")).toBe("₦150,000.00");
    expect(naira(5)).toBe("₦0.05");
    expect(naira("-100050")).toBe("−₦1,000.50");
    expect(naira("900719925474099")).toBe("₦9,007,199,254,740.99");
  });

  it("formats business dates without shifting the day", () => {
    expect(day("2026-10-06")).toBe("Tue, 6 Oct 2026");
  });

  it("escapes dynamic text and drops unsafe links", () => {
    const html = renderEmail(
      {
        subject: "<i>Hi</i>",
        preheader: "x",
        eyebrow: "e",
        tone: "neutral",
        heading: `"><script>alert(1)</script>`,
        blocks: [
          { kind: "paragraph", text: "a & b\nline two" },
          { kind: "button", label: "Click", url: "javascript:alert(1)" },
        ],
        reason: "r",
      },
      { propertyName: "Tom & Jerry's", webUrl: null },
    ).html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b<br>line two");
    expect(html).toContain("Tom &amp; Jerry&#39;s");
    expect(html).not.toContain("javascript:");
  });
});

describe("email templates", () => {
  for (const name of Object.keys(TEMPLATE_AUDIENCE) as TemplateName[]) {
    it(`renders ${name}`, () => {
      const email = renderTemplate(name, SAMPLES[name], ctx);
      expect(email.subject.length).toBeGreaterThan(5);
      for (const part of [email.subject, email.html, email.text]) {
        expect(part).not.toMatch(/undefined|NaN|\[object Object\]/);
      }
      expect(email.html).toContain("Houzz Hills Kaduna");
      expect(email.text).toContain("Houzz Hills Kaduna");
    });
  }

  it("shows balances and the guest status link for website bookings only", () => {
    const confirmed = renderTemplate("guest.booking_confirmed", { stay }, ctx);
    expect(confirmed.text).toContain("Balance due:");
    expect(confirmed.text).toContain("₦100,000.00");
    expect(confirmed.html).toContain("payment-result?reference=HH-ABC-123");
    const staffBooking = renderTemplate("guest.booking_confirmed", { stay: { ...stay, publicReference: false } }, ctx);
    expect(staffBooking.html).not.toContain("payment-result");
  });

  it("includes temporary passwords only when given", () => {
    expect(renderTemplate("staff.welcome", SAMPLES["staff.welcome"], ctx).text).toContain("Tmp-Pass-123456");
    const withoutPassword = renderTemplate("staff.welcome", { ...SAMPLES["staff.welcome"], temporaryPassword: undefined }, ctx);
    expect(withoutPassword.text).toContain("will give you your temporary password");
  });
});

describe("Resend client", () => {
  const resend = new FakeResend();
  let baseUrl: string;
  const message = { from: "Houzz Hills <a@houzzhills.test>", to: "guest@example.com", replyTo: null, subject: "Hi", html: "<p>Hi</p>", text: "Hi", tags: { template: "guest.checked_in" } };

  beforeAll(async () => {
    baseUrl = await resend.start();
  });
  afterAll(async () => {
    await resend.stop();
  });

  it("sends with the idempotency key and sanitised tags", async () => {
    const options = { baseUrl, apiKey: RESEND_TEST_KEY, timeoutMs: 2000 };
    const first = await sendWithResend(options, message, "11111111-1111-4111-8111-111111111111");
    const repeat = await sendWithResend(options, message, "11111111-1111-4111-8111-111111111111");
    expect(repeat.id).toBe(first.id);
    expect(resend.sent).toHaveLength(1);
    expect(resend.sent[0]?.tags).toEqual([{ name: "template", value: "guest_checked_in" }]);
  });

  it("classifies failures as retryable or permanent without leaking the key", async () => {
    const options = { baseUrl, apiKey: RESEND_TEST_KEY, timeoutMs: 2000 };
    resend.failNext = [503];
    await expect(sendWithResend(options, message, "a")).rejects.toMatchObject({ retryable: true });
    resend.failNext = [422];
    await expect(sendWithResend(options, message, "b")).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("not verified") });
    const rejected = await sendWithResend({ ...options, apiKey: "re_wrong_key_123" }, message, "c").catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(EmailSendError);
    expect(rejected).toMatchObject({ retryable: false });
    expect(String((rejected as Error).message)).not.toContain("re_wrong_key_123");
    await expect(sendWithResend({ ...options, baseUrl: "http://127.0.0.1:9" }, message, "d")).rejects.toMatchObject({ retryable: true });
  });
});
