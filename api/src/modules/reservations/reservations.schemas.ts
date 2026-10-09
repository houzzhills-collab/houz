import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { IdParams, IsoDate, KoboString, Nullable, StringEnum, Text, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

export const RESERVATION_STATUSES = ["hold", "pending_payment", "confirmed", "checked_in", "checked_out", "cancelled", "no_show", "expired"] as const;
export const GUEST_ID_TYPES = ["national_id", "passport", "drivers_license", "voters_card", "other"] as const;
export const GUEST_ID_SIDES = ["front", "back"] as const;
/** Front-desk views of today's stays (business date): see STAY_VIEW_SQL in the service. */
export const INCIDENT_CATEGORIES = ["broken_items", "missing_items", "overstay", "noise", "smoking", "other"] as const;
export const STAY_VIEWS = ["arrivals", "in_house", "departing", "overstay"] as const;

const GuestIdDocument = Type.Object(
  {
    id_type: StringEnum(GUEST_ID_TYPES),
    id_number: Type.String(),
    front: Type.Boolean({ description: "A photo of the front is on file" }),
    back: Type.Boolean({ description: "A photo of the back is on file" }),
    updated_at: Timestamp,
  },
  { description: "The guest's government-issued ID, or null when none is recorded" },
);

const Incident = Type.Object({
  id: Uuid,
  category: StringEnum(INCIDENT_CATEGORIES),
  description: Nullable(Type.String()),
  charge_kobo: KoboString,
  recorded_by: Nullable(Type.String()),
  created_at: Timestamp,
});

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
  charges_kobo: Type.String({ pattern: "^[0-9]+$", description: "Extra charges from incidents, owed on top of amount_kobo" }),
  incidents: Type.Array(Incident, { description: "Incidents reported for this stay, oldest first" }),
  status: Type.String(),
  payment_status: Type.String(),
  source: Type.String(),
  notes: Nullable(Type.String()),
  created_at: Timestamp,
  guest_id_document: Nullable(GuestIdDocument),
  actions: Type.Object(
    {
      next_statuses: Type.Array(Type.String(), { description: "Stay changes the caller may make now" }),
      record_payment: Type.Boolean(),
      edit: Type.Union([Type.Literal("full"), Type.Literal("stay_end"), Type.Literal("contact"), Type.Literal("none")], {
        description: "What PATCH /{id}/details may change: everything, guest details and check-out (in-house), guest details only (awaiting online payment), or nothing",
      }),
      identity: Type.Boolean({ description: "May record or change the guest's ID (PUT/DELETE /{id}/identity)" }),
    },
    { description: "What the caller may do with this reservation" },
  ),
});

const security = [{ bearerAuth: [] }];

export const ListReservationsSchema = {
  tags: ["reservations"],
  summary: "List reservations",
  description:
    "Newest check-in first. `from`/`to` select stays overlapping [from, to) and may span at most 366 days. `q` matches guest name or reference. `stay` selects a front-desk view for today: arrivals (confirmed, due to check in), in_house (checked in), departing (checked in, due out today or tomorrow) or overstay (checked in past the check-out date).",
  security,
  querystring: Type.Object(
    {
      status: Type.Optional(Type.Array(StringEnum(RESERVATION_STATUSES), { maxItems: 8 })),
      stay: Type.Optional(StringEnum(STAY_VIEWS)),
      from: Type.Optional(IsoDate),
      to: Type.Optional(IsoDate),
      q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      ...PageQuery,
    },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ reservations: Type.Array(ReservationRow), nextCursor: NextCursor }), ...errorResponses(401, 403, 422) },
};

export const StaySummarySchema = {
  tags: ["reservations"],
  summary: "Front-desk counts for today",
  description: "How many stays are in each `stay` view of GET /reservations, for the business date.",
  security,
  response: {
    200: Type.Object({ arrivals: Type.Integer(), in_house: Type.Integer(), departing: Type.Integer(), overstay: Type.Integer(), today: IsoDate }),
    ...errorResponses(401, 403),
  },
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
    "Allowed: confirmed → checked_in | cancelled | no_show; checked_in → checked_out; pending_payment → cancelled. Check-in and no-show need the arrival date to have come. Cancellation and no-show require a reason, which is audited. On check-out, `incidents` reports damage, missing items, overstay, noise, smoking or other violations; their charges are added to the guest's balance, which can still be paid after check-out.",
  security,
  params: IdParams,
  body: Type.Object(
    {
      status: Type.Union([Type.Literal("checked_in"), Type.Literal("checked_out"), Type.Literal("cancelled"), Type.Literal("no_show")]),
      reason: Type.Optional(Type.String({ minLength: 3, maxLength: 500 })),
      incidents: Type.Optional(
        Type.Array(
          Type.Object(
            {
              category: StringEnum(INCIDENT_CATEGORIES),
              description: Type.Optional(Type.String({ maxLength: 2000, description: "What happened; required for \"other\"" })),
              chargeKobo: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000_000_000, description: "Extra fee in integer kobo (NGN × 100)" })),
            },
            { additionalProperties: false },
          ),
          { maxItems: 20, description: "Only with status checked_out" },
        ),
      ),
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

export const IdentitySideParams = Type.Object({ id: Uuid, side: StringEnum(GUEST_ID_SIDES) }, { additionalProperties: false });

export const UpdateIdentitySchema = {
  tags: ["reservations"],
  summary: "Record or change the guest's government-issued ID (multipart/form-data)",
  description:
    "Fields: `idType` (" +
    GUEST_ID_TYPES.join(", ") +
    ") and `idNumber`, both required. Optional `front` and `back` file parts (JPEG, PNG or WebP, up to 5 MB each) replace the stored photo of that side; `removeFront` / `removeBack` set to `true` delete it. Audited.",
  security,
  consumes: ["multipart/form-data"],
  params: IdParams,
  response: { 200: Type.Object({ reservation: ReservationRow }), ...errorResponses(401, 403, 404, 413, 415, 422) },
};

export const DeleteIdentitySchema = {
  tags: ["reservations"],
  summary: "Remove the guest's ID and its photos",
  security,
  params: IdParams,
  response: { 200: Type.Object({ reservation: ReservationRow }), ...errorResponses(401, 403, 404) },
};

export const IdentityImageSchema = {
  tags: ["reservations"],
  summary: "A photo of the guest's ID (front or back)",
  description: "Returns the image bytes. Never cached by shared caches.",
  security,
  params: IdentitySideParams,
  produces: ["image/jpeg", "image/png", "image/webp"],
  response: { ...errorResponses(401, 403, 404) },
};
