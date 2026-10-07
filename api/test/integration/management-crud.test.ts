import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, lagosDate, login, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";

describe.skipIf(!integration)("editing and archiving workspace records", () => {
  let app: App;
  let propertyId: string;
  let owner: Awaited<ReturnType<typeof signedIn>>;
  let desk: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
    [owner, desk] = await Promise.all([signedIn(app, propertyId, "owner"), signedIn(app, propertyId, "front_desk")]);
  });
  afterAll(async () => {
    await app?.close();
  });

  const patch = (url: string, payload: Record<string, unknown>, headers = owner.headers) => app.inject({ method: "PATCH", url: `${M}${url}`, headers, payload });
  const book = (roomId: string, checkIn: string, checkOut: string, guests = 1) =>
    app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Ada Obi", roomId, checkIn, checkOut, guests } });

  it("edits a room, and retires it only when it has no upcoming stays", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 4_000_000 });
    const other = await seedRoom(app, propertyId);
    expect((await patch(`/rooms/${room.id}/details`, { roomType: "Garden Suite", nightlyRateKobo: 4_500_000, capacity: 3 })).statusCode).toBe(200);
    expect((await app.db.query("SELECT room_type, nightly_rate_kobo::text, capacity FROM rooms WHERE id = $1", [room.id]))[0]).toEqual({ room_type: "Garden Suite", nightly_rate_kobo: "4500000", capacity: 3 });
    expect((await patch(`/rooms/${room.id}/details`, { roomNumber: other.roomNumber })).json()).toMatchObject({ code: "ROOM_NUMBER_TAKEN" });
    const housekeeping = await signedIn(app, propertyId, "housekeeping");
    expect((await patch(`/rooms/${room.id}/details`, { capacity: 2 }, housekeeping.headers)).statusCode).toBe(403);

    const stay = await book(room.id, lagosDate(3), lagosDate(5));
    expect(stay.statusCode).toBe(201);
    expect((await patch(`/rooms/${room.id}/details`, { active: false })).json()).toMatchObject({ code: "ROOM_HAS_BOOKINGS" });
    expect((await patch(`/rooms/${other.id}/details`, { active: false })).statusCode).toBe(200);
    const listed = (await app.inject({ url: `${M}/rooms`, headers: owner.headers })).json<{ rooms: Array<{ id: string; active: boolean; apartment_id: string | null }> }>().rooms;
    expect(listed.find((entry) => entry.id === other.id)).toMatchObject({ active: false, apartment_id: null });
    expect((await book(other.id, lagosDate(10), lagosDate(11))).statusCode).toBe(404);
    expect((await patch(`/rooms/${other.id}/details`, { active: true })).statusCode).toBe(200);
  });

  it("edits, archives and restores stock items, keeping their ledger", async () => {
    const manager = await signedIn(app, propertyId, "restaurant_manager");
    const item = (await app.inject({ method: "POST", url: `${M}/inventory/items`, headers: manager.headers, payload: { name: "Malt", unit: "bottle", quantity: 24 } })).json<{ item: { id: string } }>().item.id;
    expect((await patch(`/inventory/items/${item}`, { name: "Malt (33cl)", reorderLevel: 6, costKobo: 50_000 }, manager.headers)).statusCode).toBe(200);
    const drink = (await app.inject({ method: "POST", url: `${M}/menu`, headers: manager.headers, payload: { name: "Malt", category: "Drinks", priceKobo: 100_000, recipe: [{ itemId: item, quantity: 1 }] } })).json<{ item: { id: string } }>().item.id;
    expect((await patch(`/inventory/items/${item}`, { active: false }, manager.headers)).json()).toMatchObject({ code: "ITEM_IN_RECIPE" });

    await patch(`/menu/${drink}`, { active: false }, manager.headers);
    expect((await patch(`/inventory/items/${item}`, { active: false }, manager.headers)).statusCode).toBe(200);
    const visible = async (query = "") => (await app.inject({ url: `${M}/inventory${query}`, headers: manager.headers })).json<{ items: Array<{ id: string; name: string; active: boolean }> }>().items.find((entry) => entry.id === item);
    expect(await visible()).toBeUndefined();
    expect(await visible("?includeArchived=true")).toMatchObject({ name: "Malt (33cl)", active: false });
    expect((await patch(`/inventory/items/${item}`, { active: true }, manager.headers)).statusCode).toBe(200);
    expect((await patch(`/menu/${drink}`, { active: true }, manager.headers)).json()).toEqual({ item: { id: drink, active: true } });

    const movements = (await app.inject({ url: `${M}/inventory/items/${item}/movements`, headers: manager.headers })).json<{ movements: Array<{ type: string; quantity_delta: string }> }>().movements;
    expect(movements).toEqual([expect.objectContaining({ type: "purchase", quantity_delta: "24.000" })]);
  });

  it("edits a staff profile, and signs the member out when their role changes", async () => {
    const created = await app.inject({
      method: "POST",
      url: `${M}/staff`,
      headers: owner.headers,
      payload: { fullName: "Bola Ade", email: `bola-${randomUUID().slice(0, 6)}@houzzhills.test`, employeeNumber: `E-${randomUUID().slice(0, 6)}`, department: "Front office", jobTitle: "Receptionist", role: "front_desk", temporaryPassword: "a temporary password" },
    });
    const staffId = created.json<{ staff: { id: string; userId: string } }>().staff.id;
    const email = (await app.db.query("SELECT u.email FROM staff_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1", [staffId]))[0].email as string;
    await login(app, email, "a temporary password");

    const edited = await patch(`/staff/${staffId}/profile`, { fullName: "Bola Adeyemi", jobTitle: "Senior receptionist", phone: "+234 801 000 0000" });
    expect(edited.json()).toEqual({ id: staffId, sessionsRevoked: 0 });
    const moved = await patch(`/staff/${staffId}/profile`, { role: "housekeeping", phone: null });
    expect(moved.json<{ sessionsRevoked: number }>().sessionsRevoked).toBeGreaterThan(0);
    const row = (await app.db.query("SELECT u.full_name, u.role, sp.job_title, sp.phone FROM staff_profiles sp JOIN users u ON u.id = sp.user_id WHERE sp.id = $1", [staffId]))[0];
    expect(row).toEqual({ full_name: "Bola Adeyemi", role: "housekeeping", job_title: "Senior receptionist", phone: null });

    const manager = await signedIn(app, propertyId, "manager");
    expect((await patch(`/staff/${staffId}/profile`, { role: "finance" }, manager.headers)).statusCode).toBe(403);
    expect((await patch(`/staff/${staffId}/profile`, { department: " " })).statusCode).toBe(422);
  });

  it("moves and re-prices a reservation, and refuses changes that do not fit", async () => {
    const room = await seedRoom(app, propertyId, { rateKobo: 3_000_000, capacity: 2 });
    const bigger = await seedRoom(app, propertyId, { rateKobo: 6_000_000, capacity: 4 });
    const created = (await book(room.id, lagosDate(20), lagosDate(22))).json<{ reservation: { id: string; amount_kobo: string; actions: { edit: string } } }>().reservation;
    expect(created).toMatchObject({ amount_kobo: "6000000", actions: { edit: "full" } });
    // The room's rate changes; the booked stay keeps its agreed nightly price.
    await app.db.query("UPDATE rooms SET nightly_rate_kobo = 9000000 WHERE id = $1", [room.id]);

    const longer = await patch(`/reservations/${created.id}/details`, { checkOut: lagosDate(23), notes: "Late arrival", email: "ADA@example.com" }, desk.headers);
    expect(longer.json()).toMatchObject({ reservation: { amount_kobo: "9000000", check_out: lagosDate(23), notes: "Late arrival", email: "ada@example.com" } });
    expect((await patch(`/reservations/${created.id}/details`, { guests: 3 }, desk.headers)).json()).toMatchObject({ code: "ROOM_CAPACITY" });
    const moved = await patch(`/reservations/${created.id}/details`, { roomId: bigger.id, guests: 3 }, desk.headers);
    expect(moved.json()).toMatchObject({ reservation: { room_id: bigger.id, guests_count: 3, amount_kobo: "18000000" } });

    const blocker = (await book(room.id, lagosDate(30), lagosDate(32))).json<{ reservation: { id: string } }>().reservation;
    expect((await patch(`/reservations/${created.id}/details`, { roomId: room.id, guests: 2, checkIn: lagosDate(30), checkOut: lagosDate(31) }, desk.headers)).json()).toMatchObject({ code: "ROOM_UNAVAILABLE" });

    const pay = await app.inject({ method: "POST", url: `${M}/reservations/${created.id}/payments`, headers: { ...desk.headers, "idempotency-key": randomUUID() }, payload: { amountKobo: 18_000_000, method: "cash" } });
    expect(pay.statusCode).toBe(201);
    expect((await patch(`/reservations/${created.id}/details`, { checkOut: lagosDate(21) }, desk.headers)).json()).toMatchObject({ code: "OVERPAID" });
    const payments = (await app.inject({ url: `${M}/reservations/${created.id}/payments`, headers: desk.headers })).json<{ payments: Array<{ amount_kobo: string; status: string }> }>().payments;
    expect(payments).toEqual([expect.objectContaining({ amount_kobo: "18000000", status: "settled", method: "cash" })]);

    await app.inject({ method: "PATCH", url: `${M}/reservations/${blocker.id}`, headers: desk.headers, payload: { status: "cancelled", reason: "Guest changed plans" } });
    expect((await patch(`/reservations/${blocker.id}/details`, { notes: "x" }, desk.headers)).json()).toMatchObject({ code: "RESERVATION_CLOSED" });
  });
});
