import multipart from "@fastify/multipart";
import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Errors } from "../../lib/errors.js";
import { requirePrincipal } from "../auth/principal.js";
import {
  CreateReservationSchema,
  DeleteIdentitySchema,
  GUEST_ID_SIDES,
  GUEST_ID_TYPES,
  IdentityImageSchema,
  ListReservationsSchema,
  RecordPaymentSchema,
  ReservationPaymentsSchema,
  UpdateIdentitySchema,
  UpdateReservationDetailsSchema,
  UpdateReservationSchema,
} from "./reservations.schemas.js";
import {
  MAX_ID_IMAGE_BYTES,
  changeReservationStatus,
  createStaffReservation,
  deleteGuestIdentity,
  listReservationPayments,
  listReservations,
  loadGuestIdentityImage,
  recordStaffPayment,
  updateGuestIdentity,
  updateReservationDetails,
  type GuestIdentityInput,
} from "./reservations.service.js";
import { optionalText } from "../../lib/text.js";

const reservationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // Scoped to this plugin: only the guest ID route accepts multipart bodies.
  await app.register(multipart, { limits: { fileSize: MAX_ID_IMAGE_BYTES, files: 2, fields: 6, fieldSize: 256, parts: 8 } });

  app.get("/", { schema: ListReservationsSchema, preHandler: app.authorize("reservations:read") }, async (request) => {
    const query = request.query;
    return listReservations(app, requirePrincipal(request), { ...query, limit: query.limit ?? 50 });
  });

  app.post("/", { schema: CreateReservationSchema, preHandler: app.authorize("reservations:write") }, async (request, reply) => {
    const body = request.body;
    const reservation = await createStaffReservation(app, requirePrincipal(request), {
      name: body.name.trim(),
      email: optionalText(body.email)?.toLowerCase() ?? null,
      phone: optionalText(body.phone),
      roomId: body.roomId,
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      guests: body.guests,
      notes: optionalText(body.notes),
    });
    return reply.status(201).send({ reservation });
  });

  app.patch("/:id", { schema: UpdateReservationSchema, preHandler: app.authorize("reservations:write") }, async (request) =>
    changeReservationStatus(app, requirePrincipal(request), request.params.id, request.body.status, request.body.reason),
  );

  app.patch("/:id/details", { schema: UpdateReservationDetailsSchema, preHandler: app.authorize("reservations:write") }, async (request) =>
    updateReservationDetails(app, requirePrincipal(request), request.params.id, request.body),
  );

  app.get("/:id/payments", { schema: ReservationPaymentsSchema, preHandler: app.authorize("reservations:read") }, async (request) =>
    listReservationPayments(app, requirePrincipal(request), request.params.id),
  );

  app.post(
    "/:id/payments",
    { schema: RecordPaymentSchema, preHandler: [app.authorize("reservations:write"), app.idempotent()] },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (request.body.idempotencyKey !== undefined && request.body.idempotencyKey !== key) {
        throw Errors.unprocessable("idempotencyKey must match the Idempotency-Key header", "IDEMPOTENCY_KEY_MISMATCH");
      }
      const result = await recordStaffPayment(app, requirePrincipal(request), request.params.id, {
        amountKobo: request.body.amountKobo,
        method: request.body.method,
        paymentReference: optionalText(request.body.paymentReference),
        idempotencyKey: key,
      });
      return reply.status(result.created ? 201 : 200).send({ payment: result.payment });
    },
  );

  app.put(
    "/:id/identity",
    { schema: UpdateIdentitySchema, preHandler: app.authorize("reservations:write"), bodyLimit: MAX_ID_IMAGE_BYTES * 2 + 64 * 1024 },
    async (request) => {
      if (!request.isMultipart()) throw Errors.unprocessable("Send the guest ID as multipart/form-data", "MULTIPART_REQUIRED");
      const fields: Record<string, string> = {};
      const images: GuestIdentityInput["images"] = {};
      const isSide = (name: string): name is (typeof GUEST_ID_SIDES)[number] => (GUEST_ID_SIDES as readonly string[]).includes(name);
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (!isSide(part.fieldname)) throw Errors.unprocessable(`Unexpected file field "${part.fieldname}"; use "front" or "back"`, "VALIDATION_FAILED");
          // Throws 413 when a file exceeds the size limit, before it is fully buffered.
          const data = await part.toBuffer();
          // An empty file input in a browser form arrives as a zero-byte part: no change.
          if (data.length > 0) images[part.fieldname] = { data };
        } else if (typeof part.value === "string") {
          fields[part.fieldname] = part.value;
        }
      }
      const idType = fields.idType;
      if (!idType || !(GUEST_ID_TYPES as readonly string[]).includes(idType)) throw Errors.unprocessable(`idType must be one of ${GUEST_ID_TYPES.join(", ")}`, "VALIDATION_FAILED");
      for (const side of GUEST_ID_SIDES) {
        const flag = `remove${side[0]!.toUpperCase()}${side.slice(1)}`;
        if (fields[flag] === "true" && !images[side]) images[side] = { remove: true };
      }
      return updateGuestIdentity(app, requirePrincipal(request), request.params.id, {
        idType: idType as GuestIdentityInput["idType"],
        idNumber: fields.idNumber ?? "",
        images,
      });
    },
  );

  app.delete("/:id/identity", { schema: DeleteIdentitySchema, preHandler: app.authorize("reservations:write") }, async (request) =>
    deleteGuestIdentity(app, requirePrincipal(request), request.params.id),
  );

  app.get("/:id/identity/:side", { schema: IdentityImageSchema, preHandler: app.authorize("reservations:read") }, async (request, reply) => {
    const image = await loadGuestIdentityImage(app, requirePrincipal(request), request.params.id, request.params.side);
    // Personal data: never kept by shared caches or the browser's disk cache.
    return reply.header("cache-control", "private, no-store").type(image.content_type).send(image.data);
  });
};

export default reservationRoutes;
