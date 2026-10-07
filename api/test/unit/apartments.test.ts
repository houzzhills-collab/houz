import { describe, expect, it } from "vitest";
import { normaliseLabels, slugify } from "../../src/modules/apartments/apartments.service.js";
import { detectImageType } from "../../src/modules/apartments/images.js";
import { mergeRanges } from "../../src/modules/apartments/public-apartments.routes.js";
import { renderTemplate, type StaySummary, type TemplateContext } from "../../src/modules/email/templates.js";

describe("apartment helpers", () => {
  it("makes URL slugs from names", () => {
    expect(slugify("Lekki Ocean-View  2 Bed (Phase 1)!")).toBe("lekki-ocean-view-2-bed-phase-1");
    expect(slugify("Café Résidence")).toBe("cafe-residence");
    expect(slugify("★")).toMatch(/^apartment/);
  });

  it("cleans label lists", () => {
    expect(normaliseLabels(["  Wi-Fi ", "wi-fi", "", "Smart   TV"])).toEqual(["Wi-Fi", "Smart TV"]);
    expect(normaliseLabels(undefined)).toBeUndefined();
  });

  it("recognises images by content, not name", () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageType(Buffer.from("RIFF0000WEBPVP8 ", "ascii"))).toBe("image/webp");
    expect(detectImageType(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(detectImageType(Buffer.from("GIF89a"))).toBeNull();
  });

  it("merges touching and overlapping booked ranges", () => {
    expect(
      mergeRanges([
        { checkIn: "2026-10-10", checkOut: "2026-10-12" },
        { checkIn: "2026-10-01", checkOut: "2026-10-03" },
        { checkIn: "2026-10-03", checkOut: "2026-10-05" },
        { checkIn: "2026-10-11", checkOut: "2026-10-11" },
      ]),
    ).toEqual([
      { checkIn: "2026-10-01", checkOut: "2026-10-05" },
      { checkIn: "2026-10-10", checkOut: "2026-10-12" },
    ]);
  });
});

describe("apartment stays in guest emails", () => {
  const ctx: TemplateContext = { brand: { propertyName: "Houzz Hills", webUrl: null }, recipientName: null, managementUrl: null, bookingUrl: null, statusUrl: () => null };
  const stay: StaySummary = {
    reference: "HH-1",
    publicReference: false,
    guestName: "Ngozi Eze",
    roomType: "Lekki Ocean View",
    roomNumber: "A-1",
    checkIn: "2026-10-06",
    checkOut: "2026-10-08",
    guests: 2,
    amountKobo: "18000000",
    paidKobo: "18000000",
    paymentStatus: "paid",
    apartment: { address: "12 Admiralty Way, Lekki Phase 1, Lagos, Lagos", directions: "Gate code at reception", checkInTime: "14:00", checkOutTime: "12:00", cautionFeeKobo: "5000000" },
  };

  it("includes the address, times, directions and caution fee in the confirmation", () => {
    const text = renderTemplate("guest.booking_confirmed", { stay }, ctx).text;
    expect(text).toContain("Lekki Ocean View · Unit A-1");
    expect(text).toContain("12 Admiralty Way");
    expect(text).toContain("from 14:00");
    expect(text).toContain("by 12:00");
    expect(text).toContain("Gate code at reception");
    expect(text).toContain("caution fee of ₦50,000.00");
  });

  it("still renders stays queued without apartment details", () => {
    const { apartment: _ignored, ...plain } = stay;
    const text = renderTemplate("guest.booking_confirmed", { stay: plain }, ctx).text;
    expect(text).toContain("Room A-1");
    expect(text).not.toContain("Caution fee");
  });
});
