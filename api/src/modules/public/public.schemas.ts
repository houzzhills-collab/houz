import { Type } from "typebox";
import { IsoDate, KoboString, Nullable, StringEnum, Text, Timestamp, errorResponses } from "../../lib/schemas.js";

export const AvailabilitySchema = {
  tags: ["public"],
  summary: "Room types available for a stay",
  description: "Counts sellable rooms per type with no overlapping active stay or unexpired checkout hold. Invalid or past date ranges return an empty list.",
  querystring: Type.Object(
    {
      checkIn: IsoDate,
      checkOut: IsoDate,
      guests: Type.Integer({ minimum: 1, maximum: 12, default: 1 }),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({
      roomTypes: Type.Array(
        Type.Object({
          room_type: Type.String(),
          nightly_rate_kobo: KoboString,
          capacity: Type.Integer(),
          available_count: Type.Integer(),
        }),
      ),
    }),
    ...errorResponses(422, 429),
  },
};

export const CreatePublicReservationSchema = {
  tags: ["public"],
  summary: "Reserve a stay and start hosted checkout, or hold it to pay later",
  description:
    "Holds one physical room, prices the full stay server-side and returns the provider checkout URL (`pay_now`, the default, held for the checkout window). With `paymentOption: pay_later` the room is held for the pay-later window instead, no checkout is started (`checkoutUrl` is null) and the guest is emailed a booking receipt; they pay later through `/public/bookings/checkout`. Requires an `Idempotency-Key` header: retries with the same key and body return the original reservation and checkout URL; the same key with a different body is rejected.",
  headers: Type.Object({ "idempotency-key": Type.String({ minLength: 8, maxLength: 128 }) }),
  body: Type.Object(
    {
      name: Text(120),
      email: Type.String({ format: "email", maxLength: 254 }),
      phone: Type.Optional(Type.String({ maxLength: 32, pattern: "^[+0-9 ()-]*$" })),
      roomType: Text(80),
      checkIn: IsoDate,
      checkOut: IsoDate,
      guests: Type.Integer({ minimum: 1, maximum: 12 }),
      notes: Type.Optional(Type.String({ maxLength: 2000 })),
      paymentOption: Type.Optional(StringEnum(["pay_now", "pay_later"] as const, { description: "Defaults to pay_now" })),
    },
    { additionalProperties: false },
  ),
  response: {
    201: Type.Object({
      reservation: Type.Object({
        id: Type.String(),
        reference: Type.String(),
        amountKobo: KoboString,
        currency: Type.Literal("NGN"),
        status: Type.Literal("pending_payment"),
        holdExpiresAt: Timestamp,
        payLater: Type.Boolean(),
      }),
      checkoutUrl: Nullable(Type.String()),
    }),
    ...errorResponses(400, 409, 422, 429, 502, 503),
  },
};

export const PaymentStatusSchema = {
  tags: ["public"],
  summary: "Payment status of an online booking",
  description: "For the guest's payment-result page. Returns no guest data. The reference is the random value returned at booking.",
  params: Type.Object({ reference: Type.String({ pattern: "^HH-[A-Z0-9-]{8,64}$" }) }, { additionalProperties: false }),
  response: {
    200: Type.Object({
      reference: Type.String(),
      paymentStatus: Type.String(),
      reservationStatus: Type.String(),
      amountKobo: KoboString,
    }),
    ...errorResponses(404, 422, 429),
  },
};

// ---- My bookings (no account) ----

const tags = ["public"];
const Email = Type.String({ format: "email", maxLength: 254 });
const Reference = Type.String({ minLength: 6, maxLength: 80, description: "Booking reference, e.g. HH-K7QM-4XPA-9C (case, spaces and dashes are ignored)" });
const SessionHeader = Type.Object({ "x-guest-session": Type.String({ minLength: 20, maxLength: 200, description: "Token from POST /public/bookings/session" }) });

const GuestBooking = Type.Object({
  reference: Type.String(),
  status: Type.String(),
  bookedOnline: Type.Boolean(),
  payLater: Type.Boolean(),
  bookedAt: Timestamp,
  holdExpiresAt: Nullable(Timestamp),
  checkIn: IsoDate,
  checkOut: IsoDate,
  nights: Type.Integer(),
  guests: Type.Integer(),
  guest: Type.Object({ name: Type.String(), email: Type.String(), phone: Nullable(Type.String()) }),
  notes: Nullable(Type.String()),
  stay: Type.Object({
    name: Type.String(),
    unitCode: Nullable(Type.String()),
    apartmentSlug: Nullable(Type.String()),
    address: Nullable(Type.String()),
    checkInTime: Nullable(Type.String()),
    checkOutTime: Nullable(Type.String()),
  }),
  payment: Type.Object({
    status: Type.String(),
    amountKobo: KoboString,
    paidKobo: KoboString,
    balanceKobo: KoboString,
    cautionFeeKobo: KoboString,
    payments: Type.Array(Type.Object({ amountKobo: KoboString, method: Type.String(), status: Type.String(), at: Timestamp })),
  }),
  canPay: Type.Boolean(),
});

export const LookupBookingSchema = {
  tags,
  summary: "Find one booking by reference and email",
  description: "For guests without an account. Returns the booking with its payments, for viewing and printing a receipt. A wrong reference or email returns 404 either way.",
  body: Type.Object({ reference: Reference, email: Email }, { additionalProperties: false }),
  response: { 200: Type.Object({ booking: GuestBooking }), ...errorResponses(404, 422, 429) },
};

export const GuestCheckoutSchema = {
  tags,
  summary: "Pay for a held booking",
  description: "Starts hosted checkout for a website booking still on hold (pay later, or a checkout the guest left), or returns the session already started. The guest returns to /payment-result.",
  body: Type.Object({ reference: Reference, email: Email }, { additionalProperties: false }),
  response: { 200: Type.Object({ checkoutUrl: Type.String() }), ...errorResponses(404, 409, 422, 429, 502, 503) },
};

export const AccessCodeSchema = {
  tags,
  summary: "Email a one-time code for My bookings",
  description: "Sends a 6-digit code to the address if it has bookings. Always answers 202, so it does not reveal whether an address has booked. One code per address per minute.",
  body: Type.Object({ email: Email }, { additionalProperties: false }),
  response: { 202: Type.Object({ expiresMinutes: Type.Integer() }), ...errorResponses(422, 429, 503) },
};

export const GuestSessionSchema = {
  tags,
  summary: "Exchange a one-time code for a guest session",
  description: "Returns a token for `x-guest-session`, valid for 30 minutes. A code works once; five wrong attempts cancel it.",
  body: Type.Object({ email: Email, code: Type.String({ pattern: "^[0-9]{6}$" }) }, { additionalProperties: false }),
  response: { 200: Type.Object({ token: Type.String(), expiresAt: Timestamp, email: Type.String() }), ...errorResponses(401, 422, 429, 503) },
};

export const GuestBookingsSchema = {
  tags,
  summary: "Every booking for the session's email",
  headers: SessionHeader,
  response: { 200: Type.Object({ email: Type.String(), bookings: Type.Array(GuestBooking) }), ...errorResponses(401, 422, 429, 503) },
};

export const EndGuestSessionSchema = {
  tags,
  summary: "Sign out of My bookings",
  headers: SessionHeader,
  response: { 204: Type.Null(), ...errorResponses(422, 429, 503) },
};
