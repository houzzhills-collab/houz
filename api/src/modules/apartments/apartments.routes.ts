import multipart from "@fastify/multipart";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { withConnection } from "../../db/sql.js";
import { Errors } from "../../lib/errors.js";
import { requirePrincipal } from "../auth/principal.js";
import {
  CalendarSchema,
  CreateApartmentSchema,
  DeleteImageSchema,
  GetApartmentSchema,
  ListApartmentsSchema,
  ListBookingsSchema,
  ReorderImagesSchema,
  UpdateApartmentSchema,
  UpdateImageSchema,
  UploadImagesSchema,
} from "./apartments.schemas.js";
import {
  addImages,
  createApartment,
  deleteImage,
  listApartments,
  loadApartment,
  reorderImages,
  toApartmentView,
  updateApartment,
  updateImage,
  type UploadedFile,
} from "./apartments.service.js";
import { apartmentCalendar, listBookings } from "./bookings.service.js";
import { MAX_IMAGES_PER_UPLOAD, MAX_IMAGE_BYTES, imageUrls } from "./images.js";

/**
 * Shortlet apartment management and the booking tracker. Listing reads need
 * `rooms:read`, changes need `rooms:create` (the people who add units), and
 * the tracker needs `reservations:read` because it shows guest details.
 */
const apartmentRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Scoped to this plugin: only the photo upload route accepts multipart bodies.
  await app.register(multipart, {
    limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_UPLOAD, fields: 5, fieldSize: 1024, parts: MAX_IMAGES_PER_UPLOAD + 5 },
  });

  app.get("/", { schema: ListApartmentsSchema, preHandler: app.authorize("rooms:read") }, async (request) =>
    listApartments(app, requirePrincipal(request), { ...request.query, limit: request.query.limit ?? 50 }),
  );

  // Static path, so it is matched before "/:id".
  app.get("/bookings", { schema: ListBookingsSchema, preHandler: app.authorize("reservations:read") }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return listBookings(app, requirePrincipal(request), { ...request.query, limit: request.query.limit ?? 50 });
  });

  app.post("/", { schema: CreateApartmentSchema, preHandler: app.authorize("rooms:create") }, async (request, reply) => {
    const apartment = await createApartment(app, requirePrincipal(request), request.body);
    return reply.status(201).send({ apartment });
  });

  app.get("/:id", { schema: GetApartmentSchema, preHandler: app.authorize("rooms:read") }, async (request) => {
    const principal = requirePrincipal(request);
    const row = await withConnection(app.db, (sql) => loadApartment(sql, principal.propertyId, request.params.id));
    return { apartment: toApartmentView(row, principal.role, imageUrls(app.config)) };
  });

  app.patch("/:id", { schema: UpdateApartmentSchema, preHandler: app.authorize("rooms:create") }, async (request) => ({
    apartment: await updateApartment(app, requirePrincipal(request), request.params.id, request.body),
  }));

  app.get("/:id/calendar", { schema: CalendarSchema, preHandler: app.authorize("reservations:read") }, async (request) =>
    apartmentCalendar(app, requirePrincipal(request), request.params.id, request.query),
  );

  app.post(
    "/:id/images",
    {
      schema: UploadImagesSchema,
      preHandler: app.authorize("rooms:create"),
      bodyLimit: MAX_IMAGE_BYTES * MAX_IMAGES_PER_UPLOAD + 64 * 1024,
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      if (!request.isMultipart()) throw Errors.unprocessable("Upload photos as multipart/form-data with `file` parts", "MULTIPART_REQUIRED");
      const files: UploadedFile[] = [];
      let caption: string | null = null;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file") throw Errors.unprocessable(`Unexpected file field "${part.fieldname}"; use "file"`, "VALIDATION_FAILED");
          // Throws 413 when a file exceeds the size limit, before it is fully buffered.
          files.push({ data: await part.toBuffer(), caption: null });
        } else if (part.fieldname === "caption" && typeof part.value === "string") {
          const text = part.value.trim().slice(0, 200);
          caption = text.length > 0 ? text : null;
        }
      }
      const result = await addImages(app, requirePrincipal(request), request.params.id, files.map((file) => ({ ...file, caption })));
      return reply.status(201).send(result);
    },
  );

  app.put("/:id/images/order", { schema: ReorderImagesSchema, preHandler: app.authorize("rooms:create") }, async (request) => ({
    apartment: await reorderImages(app, requirePrincipal(request), request.params.id, request.body.imageIds),
  }));

  app.patch("/:id/images/:imageId", { schema: UpdateImageSchema, preHandler: app.authorize("rooms:create") }, async (request) => ({
    apartment: await updateImage(app, requirePrincipal(request), request.params.id, request.params.imageId, request.body),
  }));

  app.delete("/:id/images/:imageId", { schema: DeleteImageSchema, preHandler: app.authorize("rooms:create") }, async (request) => ({
    apartment: await deleteImage(app, requirePrincipal(request), request.params.id, request.params.imageId),
  }));
};

export default apartmentRoutes;
