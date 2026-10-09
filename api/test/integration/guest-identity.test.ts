import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { createTestApp, integration, lagosDate, multipart, photo, seedProperty, seedRoom, signedIn } from "../helpers.js";

const M = "/api/v1/management";

type Row = { id: string; guest_id_document: { id_type: string; id_number: string; front: boolean; back: boolean } | null; actions: { identity: boolean } };

describe.skipIf(!integration)("guest ID on a booking", () => {
  let app: App;
  let propertyId: string;
  let desk: Awaited<ReturnType<typeof signedIn>>;
  let auditor: Awaited<ReturnType<typeof signedIn>>;

  beforeAll(async () => {
    app = await createTestApp();
    propertyId = await seedProperty(app);
    [desk, auditor] = await Promise.all([signedIn(app, propertyId, "front_desk"), signedIn(app, propertyId, "auditor")]);
  });
  afterAll(async () => {
    await app?.close();
  });

  const book = async (days: number) => {
    const room = await seedRoom(app, propertyId);
    const response = await app.inject({ method: "POST", url: `${M}/reservations`, headers: desk.headers, payload: { name: "Amina Guest", guests: 1, roomId: room.id, checkIn: lagosDate(days), checkOut: lagosDate(days + 2) } });
    expect(response.statusCode).toBe(201);
    return response.json<{ reservation: Row }>().reservation;
  };
  const putIdentity = (id: string, files: Array<{ data: Buffer; field: string }>, fields: Record<string, string>, headers = desk.headers) => {
    const body = multipart(files, fields);
    return app.inject({ method: "PUT", url: `${M}/reservations/${id}/identity`, headers: { ...headers, ...body.headers }, payload: body.payload });
  };

  it("records the ID with optional photos, serves them privately and lets staff replace or remove them", async () => {
    const reservation = await book(10);
    expect(reservation).toMatchObject({ guest_id_document: null, actions: { identity: true } });

    const numberOnly = await putIdentity(reservation.id, [], { idType: "passport", idNumber: "  A123  4567 " });
    expect(numberOnly.statusCode).toBe(200);
    expect(numberOnly.json<{ reservation: Row }>().reservation.guest_id_document).toMatchObject({ id_type: "passport", id_number: "A123 4567", front: false, back: false });

    const front = photo("front");
    const withPhotos = await putIdentity(reservation.id, [{ data: front, field: "front" }, { data: photo("back"), field: "back" }], { idType: "national_id", idNumber: "12345678901" });
    expect(withPhotos.json<{ reservation: Row }>().reservation.guest_id_document).toMatchObject({ id_type: "national_id", id_number: "12345678901", front: true, back: true });

    const image = await app.inject({ method: "GET", url: `${M}/reservations/${reservation.id}/identity/front`, headers: auditor.headers });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["cache-control"]).toBe("private, no-store");
    expect(image.rawPayload.equals(front)).toBe(true);
    expect((await app.inject({ method: "GET", url: `${M}/reservations/${reservation.id}/identity/front` })).statusCode).toBe(401);

    const removedBack = await putIdentity(reservation.id, [], { idType: "national_id", idNumber: "12345678901", removeBack: "true" });
    expect(removedBack.json<{ reservation: Row }>().reservation.guest_id_document).toMatchObject({ front: true, back: false });
    expect((await app.inject({ method: "GET", url: `${M}/reservations/${reservation.id}/identity/back`, headers: desk.headers })).statusCode).toBe(404);

    const listed = await app.inject({ method: "GET", url: `${M}/reservations?q=${encodeURIComponent("Amina")}`, headers: desk.headers });
    expect(listed.json<{ reservations: Row[] }>().reservations.find((row) => row.id === reservation.id)?.guest_id_document).toMatchObject({ id_number: "12345678901" });

    const audits: Array<{ details: Record<string, unknown> }> = await app.db.query(`SELECT details FROM audit_events WHERE entity_id = $1 AND action = 'reservation.guest_id_updated'`, [reservation.id]);
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("12345678901");

    const deleted = await app.inject({ method: "DELETE", url: `${M}/reservations/${reservation.id}/identity`, headers: desk.headers });
    expect(deleted.json<{ reservation: Row }>().reservation.guest_id_document).toBeNull();
    expect((await app.inject({ method: "GET", url: `${M}/reservations/${reservation.id}/identity/front`, headers: desk.headers })).statusCode).toBe(404);
  });

  it("validates the type, number and photos, and needs reservations:write", async () => {
    const reservation = await book(20);
    expect((await putIdentity(reservation.id, [], { idType: "library_card", idNumber: "1" })).json()).toMatchObject({ statusCode: 422 });
    expect((await putIdentity(reservation.id, [], { idType: "passport", idNumber: "   " })).json()).toMatchObject({ statusCode: 422 });
    expect((await putIdentity(reservation.id, [{ data: Buffer.from("<svg/>"), field: "front" }], { idType: "passport", idNumber: "A1" })).json()).toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    expect((await putIdentity(reservation.id, [], { idType: "passport", idNumber: "A1" }, auditor.headers)).statusCode).toBe(403);
    const auditorView = await app.inject({ method: "GET", url: `${M}/reservations?q=Amina`, headers: auditor.headers });
    expect(auditorView.json<{ reservations: Row[] }>().reservations[0]?.actions.identity).toBe(false);
  });

  it("does not reach another property's booking", async () => {
    const reservation = await book(30);
    const other = await signedIn(app, await seedProperty(app), "manager");
    expect((await putIdentity(reservation.id, [], { idType: "passport", idNumber: "A1" }, other.headers)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${M}/reservations/${reservation.id}/identity/front`, headers: other.headers })).statusCode).toBe(404);
  });
});
