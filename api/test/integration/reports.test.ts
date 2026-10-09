import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, lagosDate, seedProperty, seedRoom, seedUser, signedIn } from "../helpers.js";

const M = "/api/v1/management";
const NIGHTLY = 1_000_000;

type Report = {
  range: { key: string; from: string; to: string; granularity: string; previous: { from: string; to: string } | null };
  summary: Record<string, number | string>;
  previous: Record<string, number | string> | null;
  series: Array<Record<string, unknown>>;
  breakdowns: Record<string, Array<Record<string, unknown>>>;
  rooms_in_service: number;
};

describe.skipIf(!integration)("reports and analytics", () => {
  let app: App;
  let propertyId: string;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
    const room = await seedRoom(app, propertyId, { roomType: "Deluxe", rateKobo: NIGHTLY });
    await seedRoom(app, propertyId, { roomType: "Standard" });
    await seedRoom(app, propertyId, { roomType: "Standard", status: "maintenance" });
    const cashier = await seedUser(app, propertyId, { role: "restaurant_cashier" });

    const guest = async (name: string) => (await app.db.query<Array<{ id: string }>>("INSERT INTO guests(property_id, full_name) VALUES ($1, $2) RETURNING id", [propertyId, name]))[0]!.id;
    const reserve = async (status: string, options: { roomId?: string; checkIn: string; checkOut: string; amount: number; source?: string }) =>
      (
        await app.db.query<Array<{ id: string }>>(
          `INSERT INTO reservations(property_id, guest_id, reference, room_id, room_type, check_in, check_out, amount_kobo, status, source)
           VALUES ($1, $2, $3, $4, 'Deluxe', $5, $6, $7, $8, $9) RETURNING id`,
          [propertyId, await guest(`Guest ${status}`), `R-${status}-${Date.now()}`, options.roomId ?? null, options.checkIn, options.checkOut, options.amount, status, options.source ?? "staff"],
        )
      )[0]!.id;

    // In house for three nights (two days ago → tomorrow), partly paid today.
    const stay = await reserve("checked_in", { roomId: room.id, checkIn: lagosDate(-2), checkOut: lagosDate(1), amount: 3 * NIGHTLY });
    await app.db.query("INSERT INTO payments(property_id, reservation_id, amount_kobo, method, status, settled_at) VALUES ($1, $2, 2000000, 'cash', 'settled', now())", [propertyId, stay]);
    await app.db.query("INSERT INTO payments(property_id, reservation_id, amount_kobo, method, status) VALUES ($1, $2, 900000, 'bank_transfer', 'pending')", [propertyId, stay]);
    await reserve("cancelled", { checkIn: lagosDate(10), checkOut: lagosDate(12), amount: 2 * NIGHTLY, source: "public_website" });
    await reserve("expired", { checkIn: lagosDate(20), checkOut: lagosDate(21), amount: NIGHTLY, source: "public_website" });

    const order = (
      await app.db.query<Array<{ id: string }>>(
        `INSERT INTO pos_orders(property_id, receipt_number, subtotal_kobo, discount_kobo, total_kobo, payment_method, idempotency_key, cashier_id)
         VALUES ($1, 'RC-1', 550000, 50000, 500000, 'pos', 'report-order-1', $2) RETURNING id`,
        [propertyId, cashier.id],
      )
    )[0]!.id;
    await app.db.query("INSERT INTO pos_order_items(order_id, item_name, quantity, unit_price_kobo, line_total_kobo) VALUES ($1, 'Jollof rice', 2, 275000, 550000)", [order]);
    await app.db.query(
      "INSERT INTO pos_orders(property_id, receipt_number, subtotal_kobo, total_kobo, payment_method, idempotency_key, cashier_id, status) VALUES ($1, 'RC-2', 100000, 100000, 'cash', 'report-order-2', $2, 'voided')",
      [propertyId, cashier.id],
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  const report = async (query: string, role: "owner" | "finance" = "owner") => {
    const user = await signedIn(app, propertyId, role);
    return app.inject({ url: `${M}/reports?${query}`, headers: user.headers });
  };

  it("summarises revenue, stays, bookings and the restaurant for a period", async () => {
    const response = await report("range=last_7_days");
    expect(response.statusCode).toBe(200);
    const body = response.json<Report>();
    expect(body.range).toMatchObject({ key: "last_7_days", from: lagosDate(-6), to: lagosDate(0), granularity: "day", previous: { from: lagosDate(-13), to: lagosDate(-7) } });
    expect(body.rooms_in_service).toBe(2);
    expect(body.summary).toMatchObject({
      total_revenue_kobo: "2500000",
      room_revenue_kobo: "2000000",
      restaurant_revenue_kobo: "500000",
      room_payments: 1,
      bookings: 2,
      cancelled: 1,
      abandoned_checkouts: 1,
      nights_sold: 3,
      available_nights: 14,
      occupancy: 0.2143,
      stay_revenue_kobo: String(3 * NIGHTLY),
      adr_kobo: String(NIGHTLY),
      restaurant_orders: 1,
      avg_order_kobo: "500000",
      voided_orders: 1,
      discounts_kobo: "50000",
      new_guests: 3,
      outstanding_kobo: "1000000",
    });
    expect(body.previous).toMatchObject({ total_revenue_kobo: "0", nights_sold: 0, bookings: 0 });
    expect(body.series).toHaveLength(7);
    expect(body.series.at(-1)).toMatchObject({ start: lagosDate(0), room_revenue_kobo: "2000000", restaurant_revenue_kobo: "500000", bookings: 2, nights_sold: 1, occupancy: 0.5 });
    expect(body.breakdowns.payment_methods).toEqual([
      { method: "cash", room_kobo: "2000000", restaurant_kobo: "0", count: 1 },
      { method: "pos", room_kobo: "0", restaurant_kobo: "500000", count: 1 },
    ]);
    expect(body.breakdowns.booking_sources).toEqual(expect.arrayContaining([{ source: "staff", bookings: 1, value_kobo: String(3 * NIGHTLY) }]));
    expect(body.breakdowns.room_types?.[0]).toMatchObject({ room_type: "Deluxe", rooms: 1, nights: 3, adr_kobo: String(NIGHTLY) });
    expect(body.breakdowns.top_items).toEqual([{ name: "Jollof rice", quantity: 2, revenue_kobo: "550000" }]);
    expect(body.breakdowns.weekdays).toHaveLength(7);
  });

  it("breaks today down by hour and covers all time without a comparison", async () => {
    const today = (await report("range=today")).json<Report>();
    expect(today.range.granularity).toBe("hour");
    expect(today.series).toHaveLength(24);
    expect(today.series.reduce((total, point) => total + Number(point.room_revenue_kobo), 0)).toBe(2_000_000);
    expect(today.summary).toMatchObject({ nights_sold: 1, available_nights: 2 });

    const allTime = (await report("range=all_time", "finance")).json<Report>();
    expect(allTime.range.previous).toBeNull();
    expect(allTime.previous).toBeNull();
    expect(allTime.range.from <= lagosDate(-2)).toBe(true);
    expect(allTime.summary.total_revenue_kobo).toBe("2500000");
  });

  it("validates custom ranges and limits reports to permitted roles", async () => {
    const custom = (await report(`range=custom&from=${lagosDate(-2)}&to=${lagosDate(0)}`)).json<Report>();
    expect(custom.summary).toMatchObject({ nights_sold: 3, available_nights: 6 });
    expect((await report(`range=custom&from=${lagosDate(0)}&to=${lagosDate(-1)}`)).statusCode).toBe(422);
    expect((await report("range=custom")).statusCode).toBe(422);
    expect((await report("range=fortnight")).statusCode).toBe(422);
    for (const role of ["front_desk", "housekeeping", "restaurant_cashier"] as const) {
      const user = await signedIn(app, propertyId, role);
      expect((await app.inject({ url: `${M}/reports`, headers: user.headers })).statusCode).toBe(403);
    }
  });
});
