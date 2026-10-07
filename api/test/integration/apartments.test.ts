import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, lagosDate, multipart, photo, primaryPropertyId, signedIn } from "../helpers.js";

const M = "/api/v1/management";
const A = `${M}/apartments`;
const PUBLIC = "/api/v1/public/apartments";

type View = {
  id: string;
  roomId: string;
  slug: string;
  name: string;
  status: string;
  pricing: { nightlyRateKobo: string | null; cautionFeeKobo: string | null };
  images: Array<{ id: string; url: string; isCover: boolean; caption: string | null }>;
  amenities: string[];
  currentStay: unknown;
  nextArrival: { reference: string } | null;
};

describe.skipIf(!integration)("shortlet apartments and the booking tracker", () => {
  let app: App;
  let propertyId: string;
  let manager: Awaited<ReturnType<typeof signedIn>>;
  let desk: Awaited<ReturnType<typeof signedIn>>;
  let housekeeping: Awaited<ReturnType<typeof signedIn>>;
  let finance: Awaited<ReturnType<typeof signedIn>>;
  let apartment: View;
  const name = `Lekki Ocean View ${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    app = await createTestApp();
    // Public endpoints serve the primary property, so the apartment lives there.
    propertyId = await primaryPropertyId(app);
    [manager, desk, housekeeping, finance] = await Promise.all([
      signedIn(app, propertyId, "manager"),
      signedIn(app, propertyId, "front_desk"),
      signedIn(app, propertyId, "housekeeping"),
      signedIn(app, propertyId, "finance"),
    ]);
  });
  afterAll(async () => {
    await app?.close();
  });

  const create = (payload: Record<string, unknown>, headers = manager.headers) => app.inject({ method: "POST", url: A, headers, payload });
  const patch = (payload: Record<string, unknown>, headers = manager.headers) => app.inject({ method: "PATCH", url: `${A}/${apartment.id}`, headers, payload });
  const upload = (files: Parameters<typeof multipart>[0], fields?: Record<string, string>) => {
    const body = multipart(files, fields);
    return app.inject({ method: "POST", url: `${A}/${apartment.id}/images`, headers: { ...manager.headers, ...body.headers }, payload: body.payload });
  };
  const book = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Ngozi Eze", email: "ngozi@example.com", phone: "+2348012345678", guests: 2, roomId: apartment.roomId, ...payload } });

  it("creates a draft listing with its bookable unit, and validates it", async () => {
    const unitCode = `A-${randomUUID().slice(0, 4)}`;
    const response = await create({
      name,
      unitCode,
      category: "2-bedroom apartment",
      summary: "Sea-facing apartment with a balcony",
      location: { addressLine: "12 Admiralty Way", area: "Lekki Phase 1", city: "Lagos", state: "Lagos", latitude: 6.4474, longitude: 3.4723, directions: "Gate code at reception" },
      nightlyRateKobo: 8_500_000,
      cautionFeeKobo: 5_000_000,
      maxGuests: 4,
      bedrooms: 2,
      bathrooms: 2,
      beds: 3,
      minimumNights: 2,
      amenities: ["Wi-Fi", " wi-fi ", "Air conditioning", "", "24-hour power"],
      facilities: ["Swimming pool", "Gym"],
      features: ["Balcony"],
      houseRules: ["No smoking"],
      warrantyPolicy: "The caution fee is returned within 48 hours of check-out after inspection.",
    });
    expect(response.statusCode).toBe(201);
    apartment = response.json<{ apartment: View }>().apartment;
    expect(apartment).toMatchObject({
      status: "draft",
      slug: expect.stringMatching(/^lekki-ocean-view-/),
      pricing: { nightlyRateKobo: "8500000", cautionFeeKobo: "5000000" },
      amenities: ["Wi-Fi", "Air conditioning", "24-hour power"],
      images: [],
    });
    // The unit exists for bookings but is not sellable while the listing is a draft.
    const [room] = await app.db.query("SELECT room_number, room_type, capacity, active FROM rooms WHERE id = $1", [apartment.roomId]);
    expect(room).toEqual({ room_number: unitCode, room_type: name, capacity: 4, active: false });

    expect((await create({ name, unitCode: "B-1", category: "Studio", location: { city: "Lagos", state: "Lagos" }, nightlyRateKobo: 1, maxGuests: 1 })).json()).toMatchObject({ code: "NAME_TAKEN" });
    expect((await create({ name: `Other ${randomUUID()}`, unitCode, category: "Studio", location: { city: "Lagos", state: "Lagos" }, nightlyRateKobo: 1, maxGuests: 1 })).json()).toMatchObject({
      code: "UNIT_CODE_TAKEN",
    });
    expect((await create({ name: "No city", unitCode: "C-1", category: "Studio", location: { state: "Lagos" }, nightlyRateKobo: 1, maxGuests: 1 })).statusCode).toBe(422);
    expect((await create({ name: "Lat only", unitCode: "C-2", category: "Studio", location: { city: "Lagos", state: "Lagos", latitude: 6 }, nightlyRateKobo: 1, maxGuests: 1 })).json()).toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect((await create({ name: "Nope", unitCode: "C-3", category: "Studio", location: { city: "Lagos", state: "Lagos" }, nightlyRateKobo: 1, maxGuests: 1 }, finance.headers)).statusCode).toBe(403);
  });

  it("hides prices from housekeeping", async () => {
    const response = await app.inject({ url: `${A}/${apartment.id}`, headers: housekeeping.headers });
    expect(response.json<{ apartment: View }>().apartment.pricing).toMatchObject({ nightlyRateKobo: null, cautionFeeKobo: null });
  });

  it("needs a photo to publish; validates, de-duplicates, orders and serves photos", async () => {
    expect((await patch({ status: "published" })).json()).toMatchObject({ code: "PHOTOS_REQUIRED" });

    const notImage = await upload([{ data: Buffer.from("<svg onload=alert(1)>"), filename: "x.svg" }]);
    expect(notImage.json()).toMatchObject({ code: "UNSUPPORTED_IMAGE" });

    const uploaded = await upload([{ data: photo("living") }, { data: photo("bedroom") }, { data: photo("living") }], { caption: "Living room" });
    expect(uploaded.statusCode).toBe(201);
    const body = uploaded.json<{ uploaded: number; duplicates: number; apartment: View }>();
    expect(body).toMatchObject({ uploaded: 2, duplicates: 1 });
    const [first, second] = body.apartment.images;
    expect(first).toMatchObject({ isCover: true, caption: "Living room" });
    expect(second?.isCover).toBe(false);

    const served = await app.inject({ url: first!.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.headers["cache-control"]).toContain("immutable");
    expect(served.rawPayload.equals(photo("living"))).toBe(true);
    expect((await app.inject({ url: first!.url, headers: { "if-none-match": String(served.headers.etag) } })).statusCode).toBe(304);
    expect((await app.inject({ url: `${PUBLIC}/${apartment.id}/images/${randomUUID()}` })).statusCode).toBe(404);

    const reordered = await app.inject({ method: "PUT", url: `${A}/${apartment.id}/images/order`, headers: manager.headers, payload: { imageIds: [second!.id, first!.id] } });
    expect(reordered.json<{ apartment: View }>().apartment.images.map((image) => image.id)).toEqual([second!.id, first!.id]);
    const cover = await app.inject({ method: "PATCH", url: `${A}/${apartment.id}/images/${second!.id}`, headers: manager.headers, payload: { isCover: true } });
    expect(cover.json<{ apartment: View }>().apartment.images.map((image) => image.isCover)).toEqual([true, false]);

    const published = await patch({ status: "published", nightlyRateKobo: 9_000_000 });
    expect(published.json<{ apartment: View }>().apartment).toMatchObject({ status: "published", pricing: { nightlyRateKobo: "9000000" } });
    const [room] = await app.db.query("SELECT active, nightly_rate_kobo::text AS rate FROM rooms WHERE id = $1", [apartment.roomId]);
    expect(room).toEqual({ active: true, rate: "9000000" });

    // Deleting the cover promotes the next photo; the last photo of a published listing stays.
    expect((await app.inject({ method: "DELETE", url: `${A}/${apartment.id}/images/${second!.id}`, headers: manager.headers })).json<{ apartment: View }>().apartment.images).toMatchObject([
      { id: first!.id, isCover: true },
    ]);
    expect((await app.inject({ method: "DELETE", url: `${A}/${apartment.id}/images/${first!.id}`, headers: manager.headers })).json()).toMatchObject({ code: "PHOTOS_REQUIRED" });
  });

  it("shows published apartments to guests without the exact address", async () => {
    const list = await app.inject({ url: `${PUBLIC}?city=lagos` });
    const listed = list.json<{ apartments: Array<Record<string, unknown>> }>().apartments.find((entry) => entry.id === apartment.id);
    expect(listed).toMatchObject({ bookingRoomType: name, pricing: { nightlyRateKobo: "9000000", cautionFeeKobo: "5000000" }, location: { area: "Lekki Phase 1", city: "Lagos" } });
    expect(JSON.stringify(listed)).not.toContain("Admiralty");
    expect(JSON.stringify(listed)).not.toContain("Gate code");

    const detail = await app.inject({ url: `${PUBLIC}/${apartment.slug}` });
    expect(detail.json()).toMatchObject({ apartment: { id: apartment.id, stayRules: { minimumNights: 2 } }, bookedRanges: [] });
  });

  it("enforces the minimum stay in staff bookings and public availability", async () => {
    expect((await book({ checkIn: lagosDate(1), checkOut: lagosDate(2) })).json()).toMatchObject({ code: "MINIMUM_STAY" });
    const oneNight = await app.inject({ url: `/api/v1/public/availability?checkIn=${lagosDate(1)}&checkOut=${lagosDate(2)}&guests=1` });
    expect(oneNight.json<{ roomTypes: Array<{ room_type: string }> }>().roomTypes.map((type) => type.room_type)).not.toContain(name);
    const twoNights = await app.inject({ url: `/api/v1/public/availability?checkIn=${lagosDate(1)}&checkOut=${lagosDate(3)}&guests=1` });
    expect(twoNights.json<{ roomTypes: Array<{ room_type: string }> }>().roomTypes.map((type) => type.room_type)).toContain(name);
  });

  it("tracks bookings with booker and payment details", async () => {
    const first = await book({ checkIn: lagosDate(5), checkOut: lagosDate(8) });
    expect(first.statusCode).toBe(201);
    const reservation = first.json<{ reservation: { id: string; reference: string } }>().reservation;
    const second = await book({ name: "Musa Bello", email: "musa@example.com", checkIn: lagosDate(8), checkOut: lagosDate(10) });
    expect(second.statusCode).toBe(201);
    const pay = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `${M}/reservations/${reservation.id}/payments`, headers: { ...desk.headers, "idempotency-key": randomUUID() }, payload });
    expect((await pay({ amountKobo: 10_000_000, method: "pos" })).statusCode).toBe(201);
    expect((await pay({ amountKobo: 5_000_000, method: "bank_transfer", paymentReference: "GTB-NGOZI" })).statusCode).toBe(201);

    const tracker = await app.inject({ url: `${A}/bookings?apartmentId=${apartment.id}&q=ngozi`, headers: desk.headers });
    expect(tracker.statusCode).toBe(200);
    const body = tracker.json<{ bookings: Array<{ payment: { payments: unknown[] } } & Record<string, unknown>>; totals: Record<string, unknown> }>();
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]).toMatchObject({
      reference: reservation.reference,
      apartment: { id: apartment.id, name },
      nights: 3,
      booker: { name: "Ngozi Eze", email: "ngozi@example.com", phone: "+2348012345678" },
      payment: { status: "pending", amountKobo: "27000000", paidKobo: "10000000", pendingKobo: "5000000", balanceKobo: "17000000", cautionFeeKobo: "5000000" },
    });
    expect(body.bookings[0]?.payment.payments).toMatchObject([
      { method: "pos", status: "settled", amountKobo: "10000000" },
      { method: "bank_transfer", status: "pending", reference: "GTB-NGOZI" },
    ]);
    expect(body.totals).toMatchObject({ count: 1, amountKobo: "27000000", paidKobo: "10000000", balanceKobo: "17000000" });

    const all = await app.inject({ url: `${A}/bookings?apartmentId=${apartment.id}`, headers: desk.headers });
    expect(all.json<{ bookings: unknown[] }>().bookings).toHaveLength(2);
    expect((await app.inject({ url: `${A}/bookings`, headers: housekeeping.headers })).statusCode).toBe(403);

    const view = await app.inject({ url: `${A}/${apartment.id}`, headers: desk.headers });
    expect(view.json<{ apartment: View }>().apartment.nextArrival).toMatchObject({ reference: reservation.reference });

    const calendar = await app.inject({ url: `${A}/${apartment.id}/calendar?from=${lagosDate(0)}&to=${lagosDate(10)}`, headers: desk.headers });
    expect(calendar.json()).toMatchObject({ stats: { nights: 10, bookedNights: 5, occupancyPercent: 50, bookedAmountKobo: "45000000", paidKobo: "10000000" } });

    // Back-to-back stays show to guests as one taken range.
    const detail = await app.inject({ url: `${PUBLIC}/${apartment.slug}` });
    expect(detail.json<{ bookedRanges: unknown[] }>().bookedRanges).toEqual([{ checkIn: lagosDate(5), checkOut: lagosDate(10) }]);
    const free = await app.inject({ url: `${PUBLIC}?checkIn=${lagosDate(6)}&checkOut=${lagosDate(8)}` });
    expect(free.json<{ apartments: Array<{ id: string }> }>().apartments.map((entry) => entry.id)).not.toContain(apartment.id);
  });

  it("refuses to archive an apartment with upcoming bookings, then archives and unlists it", async () => {
    expect((await patch({ status: "archived" })).json()).toMatchObject({ code: "APARTMENT_HAS_BOOKINGS", message: expect.stringContaining("2 upcoming bookings") });
    const ids: Array<{ id: string }> = await app.db.query("SELECT id FROM reservations WHERE room_id = $1", [apartment.roomId]);
    for (const { id } of ids) {
      const cancelled = await app.inject({ method: "PATCH", url: `${M}/reservations/${id}`, headers: desk.headers, payload: { status: "cancelled", reason: "Guest changed plans" } });
      expect(cancelled.statusCode).toBe(200);
    }
    expect((await patch({ status: "archived" })).json<{ apartment: View }>().apartment.status).toBe("archived");
    expect((await app.inject({ url: `${PUBLIC}/${apartment.slug}` })).statusCode).toBe(404);
    expect((await app.inject({ url: A, headers: manager.headers })).json<{ apartments: View[] }>().apartments.map((entry) => entry.id)).not.toContain(apartment.id);
    expect((await app.inject({ url: `${A}?status=archived`, headers: manager.headers })).json<{ apartments: View[] }>().apartments.map((entry) => entry.id)).toContain(apartment.id);
  });
});
