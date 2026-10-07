import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { IdParams, IsoDate, KoboString, Nullable, StringEnum, Text, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

export const RESERVATION_STATUSES = ["hold", "pending_payment", "confirmed", "checked_in", "checked_out", "cancelled", "no_show", "expired"] as const;

export const ReservationRow = Type.Object({
  id: Uuid,
  reference: Type.String(),
  guest_name: Type.String(),
  email: Nullable(Type.String()),
  phone: Nullable(Type.String()),
  room_id: Nullable(Uuid),
  room_type: Type.String(),
  room_number: Nullable(Type.String()),
  check_in: IsoDate,
  check_out: IsoDate,
  guests_count: Type.Integer(),
  amount_kobo: KoboString,
  paid_kobo: KoboString,
  status: Type.String(),
  payment_status: Type.String(),
  source: Type.String(),
  notes: Nullable(Type.String()),
  created_at: Timestamp,
  actions: Type.Object(
    {
      next_statuses: Type.Array(Type.String(), { description: "Stay changes the caller may make now" }),
      record_payment: Type.Boolean(),
      edit: Type.Union([Type.Literal("full"), Type.Literal("stay_end"), Type.Literal("contact"), Type.Literal("none")], {
        description: "What PATCH /{id}/details may change: everything, guest details and check-out (in-house), guest details only (awaiting online payment), or nothing",
      }),
    },
    { description: "What the caller may do with this reservation" },
  ),
});

const security = [{ bearerAuth: [] }];

export const ListReservationsSchema = {
  tags: ["reservations"],
  summary: "List reservations",
  description: "Newest check-in first. `from`/`to` select stays overlapping [from, to) and may span at most 366 days. `q` matches guest name or reference.",
  security,
  querystring: Type.Object(
    {
      status: Type.Optional(Type.Array(StringEnum(RESERVATION_STATUSES), { maxItems: 8 })),
      from: Type.Optional(IsoDate),
      to: Type.Optional(IsoDate),
      q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      ...PageQuery,
    },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ reservations: Type.Array(ReservationRow), nextCursor: NextCursor }), ...errorResponses(401, 403, 422) },
};

export const CreateReservationSchema = {
  tags: ["reservations"],
  summary: "Create a staff booking for a specific room",
  description: "Creates a confirmed reservation priced from the room rate. Staff collect payment separately. Overlapping active stays are rejected (409).",
  security,
  body: Type.Object(
    {
      name: Text(120),
      email: Type.Optional(Type.Union([Type.String({ format: "email", maxLength: 254 }), Type.Literal("")])),
      phone: Type.Optional(Type.String({ maxLength: 32, pattern: "^[+0-9 ()-]*$" })),
      roomId: Uuid,
      checkIn: IsoDate,
      checkOut: IsoDate,
      guests: Type.Integer({ minimum: 1, maximum: 12 }),
      notes: Type.Optional(Type.String({ maxLength: 2000 })),
    },
    { additionalProperties: false },
  ),
  response: { 201: Type.Object({ reservation: ReservationRow }), ...errorResponses(401, 403, 404, 409, 422) },
};

export const UpdateReservationSchema = {
  tags: ["reservations"],
  summary: "Change a reservation's stay status",
  description:
    "Allowed: confirmed → checked_in | cancelled | no_show; checked_in → checked_out; pending_payment → cancelled. Check-in and no-show need the arrival date to have come. Cancellation and no-show require a reason, which is audited.",
  security,
  params: IdParams,
  body: Type.Object(
    {
      status: Type.Union([Type.Literal("checked_in"), Type.Literal("checked_out"), Type.Literal("cancelled"), Type.Literal("no_show")]),
      reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
    },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ reservation: Type.Object({ id: Uuid, status: Type.String() }) }), ...errorResponses(401, 403, 404, 409, 422) },
};

export const UpdateReservationDetailsSchema = {
  tags: ["reservations"],
  summary: "Edit a reservation's guest details, dates, room or guest count",
  description:
    "Only sent fields change; null clears email, phone or notes. `actions.edit` on the reservation says what may change. Moving dates or room re-checks availability, capacity and minimum stay, and re-prices the stay: the same room keeps its agreed nightly price, another room uses its current rate. The payment status is recalculated.",
  security,
  params: IdParams,
  body: Type.Object(
    {
      name: Type.Optional(Text(120)),
      email: Type.Optional(Nullable(Type.String({ format: "email", maxLength: 254 }))),
      phone: Type.Optional(Nullable(Type.String({ maxLength: 32, pattern: "^[+0-9 ()-]*$" }))),
      notes: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
      guests: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
      roomId: Type.Optional(Uuid),
      checkIn: Type.Optional(IsoDate),
      checkOut: Type.Optional(IsoDate),
    },
    { additionalProperties: false, minProperties: 1 },
  ),
  response: { 200: Type.Object({ reservation: ReservationRow }), ...errorResponses(401, 403, 404, 409, 422) },
};

export const ReservationPaymentsSchema = {
  tags: ["reservations"],
  summary: "Payments recorded against a reservation",
  security,
  params: IdParams,
  response: {
    200: Type.Object({
      payments: Type.Array(
        Type.Object({
          id: Uuid,
          amount_kobo: KoboString,
          method: Type.String(),
          status: Type.String(),
          reference: Nullable(Type.String()),
          recorded_by: Nullable(Type.String()),
          created_at: Timestamp,
          settled_at: Nullable(Timestamp),
        }),
      ),
    }),
    ...errorResponses(401, 403, 404),
  },
};

export const RecordPaymentSchema = {
  tags: ["reservations"],
  summary: "Record a staff-collected payment",
  description:
    "Cash and POS terminal payments settle immediately; bank transfers stay pending until an owner or manager confirms them. Online payments can only be settled by the provider. Requires `Idempotency-Key` (the legacy `idempotencyKey` body field, if sent, must match).",
  security,
  params: IdParams,
  headers: Type.Object({ "idempotency-key": Type.String({ minLength: 8, maxLength: 128 }) }),
  body: Type.Object(
    {
      amountKobo: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Integer kobo (NGN × 100)" }),
      method: Type.Union([Type.Literal("cash"), Type.Literal("pos"), Type.Literal("bank_transfer")]),
      paymentReference: Type.Optional(Type.String({ maxLength: 120 })),
      idempotencyKey: Type.Optional(Type.String({ minLength: 8, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object({ payment: Type.Object({ id: Uuid, duplicate: Type.Boolean(), paid: Type.Boolean(), paymentStatus: Type.Union([Type.Literal("pending"), Type.Literal("settled")]) }) }),
    200: Type.Object({ payment: Type.Object({ id: Uuid, duplicate: Type.Boolean(), paid: Type.Boolean(), paymentStatus: Type.Union([Type.Literal("pending"), Type.Literal("settled")]) }) }),
    ...errorResponses(401, 403, 404, 409, 422),
  },
};
