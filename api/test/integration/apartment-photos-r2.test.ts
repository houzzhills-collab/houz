import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/app.js";
import { FakeR2, R2_TEST_ACCESS_KEY, R2_TEST_BUCKET, R2_TEST_SECRET } from "../fakes/r2.js";
import { createTestApp, integration, multipart, photo, seedProperty, signedIn } from "../helpers.js";

const A = "/api/v1/management/apartments";
const CDN = "https://media.houzzhills.test";

type Image = { id: string; url: string; isCover: boolean };

describe.skipIf(!integration)("apartment photos in Cloudflare R2", () => {
  const r2 = new FakeR2();
  let app: App;
  let cdnApp: App;
  let manager: Awaited<ReturnType<typeof signedIn>>;
  let apartmentId: string;

  beforeAll(async () => {
    const endpoint = await r2.start();
    const env = { R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: R2_TEST_ACCESS_KEY, R2_SECRET_ACCESS_KEY: R2_TEST_SECRET, R2_BUCKET: R2_TEST_BUCKET, STORAGE_TIMEOUT_MS: "3000" };
    app = await createTestApp(env);
    const propertyId = await seedProperty(app);
    manager = await signedIn(app, propertyId, "manager");
    const created = await app.inject({
      method: "POST",
      url: A,
      headers: manager.headers,
      payload: { name: `R2 Suite ${randomUUID().slice(0, 6)}`, unitCode: `R2-${randomUUID().slice(0, 4)}`, category: "Studio", location: { city: "Abuja", state: "FCT" }, nightlyRateKobo: 4_000_000, maxGuests: 2 },
    });
    apartmentId = created.json<{ apartment: { id: string } }>().apartment.id;
    // Booted last: booting blocks the event loop, which would make the first app shed the requests above.
    cdnApp = await createTestApp({ ...env, R2_PUBLIC_URL: CDN });
  });
  afterAll(async () => {
    await app?.close();
    await cdnApp?.close();
    await r2.stop();
  });
  beforeEach(() => {
    r2.failNext = [];
  });

  const upload = (files: Parameters<typeof multipart>[0], target = app) => {
    const body = multipart(files);
    return target.inject({ method: "POST", url: `${A}/${apartmentId}/images`, headers: { ...manager.headers, ...body.headers }, payload: body.payload });
  };
  const rows = (): Promise<Array<{ id: string; storage_key: string | null; has_data: boolean }>> =>
    app.db.query("SELECT id, storage_key, data IS NOT NULL AS has_data FROM apartment_images WHERE apartment_id = $1 ORDER BY position", [apartmentId]);

  it("uploads to the bucket with long-lived cache headers and keeps no bytes in PostgreSQL", async () => {
    const response = await upload([{ data: photo("r2-one") }]);
    expect(response.statusCode).toBe(201);
    const [image] = response.json<{ apartment: { images: Image[] } }>().apartment.images;
    const [row] = await rows();
    expect(row).toEqual({ id: image!.id, storage_key: `apartments/${apartmentId}/${image!.id}.png`, has_data: false });
    const stored = r2.objects.get(row!.storage_key!);
    expect(stored).toMatchObject({ contentType: "image/png", cacheControl: "public, max-age=31536000, immutable" });
    expect(stored?.data.equals(photo("r2-one"))).toBe(true);

    // Without a public bucket URL the API streams the photo from R2.
    expect(image!.url).toBe(`/api/v1/public/apartments/${apartmentId}/images/${image!.id}`);
    const served = await app.inject({ url: image!.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toBe("image/png");
    expect(served.rawPayload.equals(photo("r2-one"))).toBe(true);
    expect((await app.inject({ url: image!.url, headers: { "if-none-match": String(served.headers.etag) } })).statusCode).toBe(304);
  });

  it("points photo URLs at the CDN when the bucket is public, and redirects old API links", async () => {
    const view = await cdnApp.inject({ url: `${A}/${apartmentId}`, headers: manager.headers });
    const [image] = view.json<{ apartment: { images: Image[] } }>().apartment.images;
    expect(image!.url).toBe(`${CDN}/apartments/${apartmentId}/${image!.id}.png`);
    const legacy = await cdnApp.inject({ url: `/api/v1/public/apartments/${apartmentId}/images/${image!.id}` });
    expect(legacy.statusCode).toBe(302);
    expect(legacy.headers.location).toBe(image!.url);
  });

  it("does not upload duplicates", async () => {
    const before = r2.keys().length;
    const response = await upload([{ data: photo("r2-one") }]);
    expect(response.json()).toMatchObject({ uploaded: 0, duplicates: 1 });
    expect(r2.keys().length).toBe(before);
  });

  it("fails cleanly when R2 is down: nothing recorded, nothing left behind", async () => {
    const before = r2.keys().length;
    r2.failNext = [500, 500, 500];
    const response = await upload([{ data: photo("r2-down") }]);
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE", message: "File storage could not be reached. Try again shortly." });
    expect(response.body).not.toContain(R2_TEST_SECRET);
    expect(await rows()).toHaveLength(1);
    expect(r2.keys().length).toBe(before);
  });

  it("refuses over-limit uploads before touching the bucket", async () => {
    // Fill the apartment up to the 30-photo limit.
    await app.db.query(
      `INSERT INTO apartment_images(apartment_id, content_type, byte_size, sha256, data, position)
       SELECT $1, 'image/png', 1, md5(random()::text) || g, '\\x00', 100 + g FROM generate_series(1, 29) g`,
      [apartmentId],
    );
    const before = r2.keys().length;
    const response = await upload([{ data: photo("r2-over") }]);
    expect(response.json()).toMatchObject({ code: "TOO_MANY_IMAGES" });
    expect(r2.keys().length).toBe(before);
    await app.db.query("DELETE FROM apartment_images WHERE apartment_id = $1 AND position >= 100", [apartmentId]);
  });

  it("deletes the object when a photo is removed", async () => {
    const added = await upload([{ data: photo("r2-two") }]);
    const images = added.json<{ apartment: { images: Image[] } }>().apartment.images;
    const second = images[1]!;
    const key = `apartments/${apartmentId}/${second.id}.png`;
    expect(r2.objects.has(key)).toBe(true);
    const removed = await app.inject({ method: "DELETE", url: `${A}/${apartmentId}/images/${second.id}`, headers: manager.headers });
    expect(removed.statusCode).toBe(200);
    expect(r2.objects.has(key)).toBe(false);
  });
});
