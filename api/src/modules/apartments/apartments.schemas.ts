import { Type } from "typebox";
import { NextCursor, PageQuery } from "../../lib/pagination.js";
import { IdParams, IsoDate, KoboInput, KoboString, Nullable, StringEnum, Text, Timestamp, Uuid, errorResponses } from "../../lib/schemas.js";

export const APARTMENT_STATUSES = ["draft", "published", "archived"] as const;
export type ApartmentStatus = (typeof APARTMENT_STATUSES)[number];

const security = [{ bearerAuth: [] }];
const tags = ["apartments"];

const Time = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", description: "24-hour HH:MM" });
const Slug = Type.String({ minLength: 2, maxLength: 80, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "URL name, e.g. `ocean-view-2-bed`" });
/** Short labels such as "Wi-Fi" or "Swimming pool". Blank and duplicate entries are dropped. */
const Labels = (description: string) => Type.Array(Type.String({ maxLength: 80 }), { maxItems: 60, description });
const LongText = (maxLength: number) => Type.String({ maxLength });
const Count = (maximum: number) => Type.Integer({ minimum: 0, maximum });

const LocationFields = {
  addressLine: LongText(200),
  area: LongText(120),
  city: Text(80),
  state: Text(80),
  country: Text(80),
  latitude: Type.Number({ minimum: -90, maximum: 90 }),
  longitude: Type.Number({ minimum: -180, maximum: 180 }),
  directions: LongText(2000),
};

/** Fields shared by create and update. On update every field is optional and nullable text clears it. */
const ApartmentFields = {
  name: Text(80),
  unitCode: Type.String({ minLength: 1, maxLength: 20, description: "Short internal code, unique per property (the unit's room number)" }),
  slug: Slug,
  category: Type.String({ minLength: 1, maxLength: 60, description: "e.g. Studio, 1-bedroom, 3-bedroom duplex" }),
  summary: LongText(300),
  description: LongText(10_000),
  nightlyRateKobo: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Price per night in kobo (NGN × 100)" }),
  cautionFeeKobo: KoboInput,
  maxGuests: Type.Integer({ minimum: 1, maximum: 12 }),
  bedrooms: Count(50),
  bathrooms: Count(50),
  beds: Count(100),
  sizeSqm: Type.Number({ exclusiveMinimum: 0, maximum: 100_000 }),
  minimumNights: Type.Integer({ minimum: 1, maximum: 365 }),
  checkInTime: Time,
  checkOutTime: Time,
  amenities: Labels("In-unit amenities, e.g. Wi-Fi, Air conditioning, Smart TV, 24-hour power"),
  features: Labels("Selling points, e.g. Balcony, Ocean view, Workspace"),
  facilities: Labels("Shared facilities, e.g. Swimming pool, Gym, Parking, Security"),
  houseRules: Labels("e.g. No smoking, No parties"),
  warrantyPolicy: LongText(5000),
  cancellationPolicy: LongText(5000),
};

const opt = <T extends Parameters<typeof Type.Optional>[0]>(schema: T) => Type.Optional(schema);
const optNullable = <T extends Parameters<typeof Nullable>[0]>(schema: T) => Type.Optional(Nullable(schema));

export const CreateApartmentBody = Type.Object(
  {
    name: ApartmentFields.name,
    unitCode: ApartmentFields.unitCode,
    slug: opt(ApartmentFields.slug),
    category: ApartmentFields.category,
    summary: opt(ApartmentFields.summary),
    description: opt(ApartmentFields.description),
    location: Type.Object(
      {
        addressLine: opt(LocationFields.addressLine),
        area: opt(LocationFields.area),
        city: LocationFields.city,
        state: LocationFields.state,
        country: opt(LocationFields.country),
        latitude: opt(LocationFields.latitude),
        longitude: opt(LocationFields.longitude),
        directions: opt(LocationFields.directions),
      },
      { additionalProperties: false },
    ),
    nightlyRateKobo: ApartmentFields.nightlyRateKobo,
    cautionFeeKobo: opt(ApartmentFields.cautionFeeKobo),
    maxGuests: ApartmentFields.maxGuests,
    bedrooms: opt(ApartmentFields.bedrooms),
    bathrooms: opt(ApartmentFields.bathrooms),
    beds: opt(ApartmentFields.beds),
    sizeSqm: opt(ApartmentFields.sizeSqm),
    minimumNights: opt(ApartmentFields.minimumNights),
    checkInTime: opt(ApartmentFields.checkInTime),
    checkOutTime: opt(ApartmentFields.checkOutTime),
    amenities: opt(ApartmentFields.amenities),
    features: opt(ApartmentFields.features),
    facilities: opt(ApartmentFields.facilities),
    houseRules: opt(ApartmentFields.houseRules),
    warrantyPolicy: opt(ApartmentFields.warrantyPolicy),
    cancellationPolicy: opt(ApartmentFields.cancellationPolicy),
  },
  { additionalProperties: false },
);

export const UpdateApartmentBody = Type.Object(
  {
    name: opt(ApartmentFields.name),
    unitCode: opt(ApartmentFields.unitCode),
    slug: opt(ApartmentFields.slug),
    category: opt(ApartmentFields.category),
    summary: optNullable(ApartmentFields.summary),
    description: optNullable(ApartmentFields.description),
    status: opt(StringEnum(APARTMENT_STATUSES, { description: "Publishing needs at least one photo; archiving needs no upcoming bookings" })),
    location: opt(
      Type.Object(
        {
          addressLine: optNullable(LocationFields.addressLine),
          area: optNullable(LocationFields.area),
          city: opt(LocationFields.city),
          state: opt(LocationFields.state),
          country: opt(LocationFields.country),
          latitude: optNullable(LocationFields.latitude),
          longitude: optNullable(LocationFields.longitude),
          directions: optNullable(LocationFields.directions),
        },
        { additionalProperties: false, minProperties: 1 },
      ),
    ),
    nightlyRateKobo: opt(ApartmentFields.nightlyRateKobo),
    cautionFeeKobo: opt(ApartmentFields.cautionFeeKobo),
    maxGuests: opt(ApartmentFields.maxGuests),
    bedrooms: opt(ApartmentFields.bedrooms),
    bathrooms: opt(ApartmentFields.bathrooms),
    beds: opt(ApartmentFields.beds),
    sizeSqm: optNullable(ApartmentFields.sizeSqm),
    minimumNights: opt(ApartmentFields.minimumNights),
    checkInTime: opt(ApartmentFields.checkInTime),
    checkOutTime: opt(ApartmentFields.checkOutTime),
    amenities: opt(ApartmentFields.amenities),
    features: opt(ApartmentFields.features),
    facilities: opt(ApartmentFields.facilities),
    houseRules: opt(ApartmentFields.houseRules),
    warrantyPolicy: optNullable(ApartmentFields.warrantyPolicy),
    cancellationPolicy: optNullable(ApartmentFields.cancellationPolicy),
  },
  { additionalProperties: false, minProperties: 1 },
);

const Image = Type.Object({
  id: Uuid,
  url: Type.String({ description: "Public, cacheable image URL (relative to the API origin)" }),
  caption: Nullable(Type.String()),
  position: Type.Integer(),
  isCover: Type.Boolean(),
  contentType: Type.String(),
  byteSize: Type.Integer(),
});

const Location = Type.Object({
  addressLine: Nullable(Type.String()),
  area: Nullable(Type.String()),
  city: Type.String(),
  state: Type.String(),
  country: Type.String(),
  latitude: Nullable(Type.Number()),
  longitude: Nullable(Type.Number()),
  directions: Nullable(Type.String()),
});

const Stay = Type.Object({ reference: Type.String(), guestName: Nullable(Type.String()), checkIn: IsoDate, checkOut: IsoDate, status: Type.String() });

export const Apartment = Type.Object({
  id: Uuid,
  roomId: Uuid,
  slug: Type.String(),
  name: Type.String(),
  unitCode: Type.String(),
  category: Type.String(),
  summary: Nullable(Type.String()),
  description: Nullable(Type.String()),
  status: StringEnum(APARTMENT_STATUSES),
  location: Location,
  pricing: Type.Object({
    nightlyRateKobo: Nullable(KoboString),
    cautionFeeKobo: Nullable(KoboString),
    currency: Type.Literal("NGN"),
  }),
  capacity: Type.Object({ maxGuests: Type.Integer(), bedrooms: Type.Integer(), bathrooms: Type.Integer(), beds: Type.Integer(), sizeSqm: Nullable(Type.Number()) }),
  stayRules: Type.Object({ minimumNights: Type.Integer(), checkInTime: Type.String(), checkOutTime: Type.String() }),
  amenities: Type.Array(Type.String()),
  features: Type.Array(Type.String()),
  facilities: Type.Array(Type.String()),
  houseRules: Type.Array(Type.String()),
  policies: Type.Object({ warranty: Nullable(Type.String()), cancellation: Nullable(Type.String()) }),
  images: Type.Array(Image),
  unitStatus: Type.String({ description: "Housekeeping state of the unit (vacant_clean, occupied, maintenance, …)" }),
  currentStay: Nullable(Stay),
  nextArrival: Nullable(Stay),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const ApartmentResponse = Type.Object({ apartment: Apartment });

export const ListApartmentsSchema = {
  tags,
  summary: "Apartments with location, pricing, photos and who is staying now",
  description: "Housekeeping sees no prices or guest names.",
  security,
  querystring: Type.Object(
    {
      ...PageQuery,
      status: opt(StringEnum(APARTMENT_STATUSES)),
      city: opt(Type.String({ maxLength: 80 })),
      q: opt(Type.String({ maxLength: 80, description: "Matches name, unit code, category or area" })),
    },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ apartments: Type.Array(Apartment), nextCursor: NextCursor }), ...errorResponses(401, 403, 422) },
};

export const GetApartmentSchema = { tags, summary: "One apartment", security, params: IdParams, response: { 200: ApartmentResponse, ...errorResponses(401, 403, 404) } };

export const CreateApartmentSchema = {
  tags,
  summary: "Add an apartment",
  description:
    "Creates the listing as a draft together with its bookable unit. Upload photos, then PATCH `status: published` to open it for booking. `slug` is derived from the name when omitted.",
  security,
  body: CreateApartmentBody,
  response: { 201: ApartmentResponse, ...errorResponses(401, 403, 409, 422) },
};

export const UpdateApartmentSchema = {
  tags,
  summary: "Edit, publish, unpublish or archive an apartment",
  description:
    "Only sent fields change; null clears optional text. Price and capacity changes apply to new bookings only. Lists (amenities, features, …) are replaced as a whole.",
  security,
  params: IdParams,
  body: UpdateApartmentBody,
  response: { 200: ApartmentResponse, ...errorResponses(401, 403, 404, 409, 422) },
};

export const ImageParams = Type.Object({ id: Uuid, imageId: Uuid }, { additionalProperties: false });

export const UploadImagesSchema = {
  tags,
  summary: "Upload photos (multipart/form-data)",
  description:
    "Send one or more `file` parts (JPEG, PNG or WebP, up to 8 MB each, up to 10 per request and 30 per apartment), and optionally a `caption` field that applies to them. The first photo becomes the cover. Re-uploading an identical photo is ignored.",
  security,
  consumes: ["multipart/form-data"],
  params: IdParams,
  response: {
    201: Type.Object({ uploaded: Type.Integer(), duplicates: Type.Integer(), apartment: Apartment }),
    ...errorResponses(401, 403, 404, 409, 413, 415, 422),
  },
};

export const UpdateImageSchema = {
  tags,
  summary: "Change a photo's caption or make it the cover",
  security,
  params: ImageParams,
  body: Type.Object(
    { caption: optNullable(Type.String({ maxLength: 200 })), isCover: opt(Type.Literal(true, { description: "Only `true`: choose another photo to replace the cover" })) },
    { additionalProperties: false, minProperties: 1 },
  ),
  response: { 200: ApartmentResponse, ...errorResponses(401, 403, 404, 422) },
};

export const ReorderImagesSchema = {
  tags,
  summary: "Set the photo order",
  security,
  params: IdParams,
  body: Type.Object({ imageIds: Type.Array(Uuid, { minItems: 1, maxItems: 30, description: "Every photo of the apartment, in display order" }) }, { additionalProperties: false }),
  response: { 200: ApartmentResponse, ...errorResponses(401, 403, 404, 422) },
};

export const DeleteImageSchema = {
  tags,
  summary: "Delete a photo",
  description: "A published apartment must keep at least one photo.",
  security,
  params: ImageParams,
  response: { 200: ApartmentResponse, ...errorResponses(401, 403, 404, 409) },
};

// ---- Booking tracker ----

const BOOKING_STATUSES = ["pending_payment", "confirmed", "checked_in", "checked_out", "cancelled", "no_show", "expired"] as const;
const PAYMENT_STATUSES = ["unpaid", "pending", "part_paid", "paid"] as const;

const BookingPayment = Type.Object({
  id: Uuid,
  amountKobo: KoboString,
  method: Type.String(),
  status: Type.String(),
  reference: Nullable(Type.String({ description: "Transfer sender/reference or provider reference" })),
  provider: Nullable(Type.String()),
  recordedBy: Nullable(Type.String()),
  confirmedBy: Nullable(Type.String()),
  createdAt: Timestamp,
  settledAt: Nullable(Timestamp),
});

export const Booking = Type.Object({
  id: Uuid,
  reference: Type.String(),
  apartment: Type.Object({ id: Uuid, name: Type.String(), unitCode: Type.String(), slug: Type.String() }),
  status: Type.String(),
  source: Type.String({ description: "public_website or staff" }),
  checkIn: IsoDate,
  checkOut: IsoDate,
  nights: Type.Integer(),
  guests: Type.Integer(),
  booker: Type.Object({ name: Type.String(), email: Nullable(Type.String()), phone: Nullable(Type.String()) }),
  notes: Nullable(Type.String()),
  payment: Type.Object({
    status: Type.String(),
    amountKobo: KoboString,
    paidKobo: KoboString,
    pendingKobo: KoboString,
    balanceKobo: KoboString,
    cautionFeeKobo: KoboString,
    payments: Type.Array(BookingPayment),
  }),
  holdExpiresAt: Nullable(Timestamp),
  createdBy: Nullable(Type.String()),
  createdAt: Timestamp,
});

export const ListBookingsSchema = {
  tags,
  summary: "Booking tracker: every apartment booking with booker and payment details",
  description:
    "Filter by apartment, stay dates (any stay overlapping `from`–`to`), booking status, payment status or a search on booker name, email, phone and reference. `totals` cover every booking matching the filters, not just this page.",
  security,
  querystring: Type.Object(
    {
      ...PageQuery,
      apartmentId: opt(Uuid),
      from: opt(IsoDate),
      to: opt(IsoDate),
      status: opt(Type.Array(StringEnum(BOOKING_STATUSES), { maxItems: BOOKING_STATUSES.length })),
      paymentStatus: opt(StringEnum(PAYMENT_STATUSES)),
      q: opt(Type.String({ maxLength: 80 })),
    },
    { additionalProperties: false },
  ),
  response: {
    200: Type.Object({
      bookings: Type.Array(Booking),
      nextCursor: NextCursor,
      totals: Type.Object({ count: Type.Integer(), amountKobo: KoboString, paidKobo: KoboString, balanceKobo: KoboString }),
    }),
    ...errorResponses(401, 403, 422),
  },
};

export const CalendarSchema = {
  tags,
  summary: "When an apartment is booked, with occupancy and revenue for the period",
  description: "Defaults to today and the next 90 days. Holds still awaiting online payment are included as `pending_payment`.",
  security,
  params: IdParams,
  querystring: Type.Object({ from: opt(IsoDate), to: opt(IsoDate) }, { additionalProperties: false }),
  response: {
    200: Type.Object({
      apartment: Type.Object({ id: Uuid, name: Type.String(), unitCode: Type.String() }),
      from: IsoDate,
      to: IsoDate,
      stays: Type.Array(
        Type.Object({
          reservationId: Uuid,
          reference: Type.String(),
          status: Type.String(),
          paymentStatus: Type.String(),
          checkIn: IsoDate,
          checkOut: IsoDate,
          guestName: Type.String(),
          guests: Type.Integer(),
        }),
      ),
      stats: Type.Object({
        nights: Type.Integer({ description: "Nights in the period" }),
        bookedNights: Type.Integer(),
        occupancyPercent: Type.Integer(),
        bookedAmountKobo: KoboString,
        paidKobo: KoboString,
      }),
    }),
    ...errorResponses(401, 403, 404, 422),
  },
};

// ---- Public ----

export const PublicApartment = Type.Object({
  id: Uuid,
  slug: Type.String(),
  name: Type.String(),
  bookingRoomType: Type.String({ description: "Send as `roomType` to POST /public/reservations to book this apartment" }),
  category: Type.String(),
  summary: Nullable(Type.String()),
  description: Nullable(Type.String()),
  location: Type.Object({ area: Nullable(Type.String()), city: Type.String(), state: Type.String(), country: Type.String() }),
  pricing: Type.Object({ nightlyRateKobo: KoboString, cautionFeeKobo: KoboString, currency: Type.Literal("NGN") }),
  capacity: Type.Object({ maxGuests: Type.Integer(), bedrooms: Type.Integer(), bathrooms: Type.Integer(), beds: Type.Integer(), sizeSqm: Nullable(Type.Number()) }),
  stayRules: Type.Object({ minimumNights: Type.Integer(), checkInTime: Type.String(), checkOutTime: Type.String() }),
  amenities: Type.Array(Type.String()),
  features: Type.Array(Type.String()),
  facilities: Type.Array(Type.String()),
  houseRules: Type.Array(Type.String()),
  policies: Type.Object({ warranty: Nullable(Type.String()), cancellation: Nullable(Type.String()) }),
  images: Type.Array(Type.Object({ id: Uuid, url: Type.String(), caption: Nullable(Type.String()), isCover: Type.Boolean() })),
});

export const PublicListSchema = {
  tags: ["public"],
  summary: "Published apartments",
  description: "With `checkIn` and `checkOut`, only apartments free for the whole stay (and whose minimum stay it meets) are returned. The exact address is shared with guests after booking.",
  querystring: Type.Object(
    {
      ...PageQuery,
      city: opt(Type.String({ maxLength: 80 })),
      guests: opt(Type.Integer({ minimum: 1, maximum: 12 })),
      checkIn: opt(IsoDate),
      checkOut: opt(IsoDate),
    },
    { additionalProperties: false },
  ),
  response: { 200: Type.Object({ apartments: Type.Array(PublicApartment), nextCursor: NextCursor }), ...errorResponses(422, 429) },
};

export const PublicDetailSchema = {
  tags: ["public"],
  summary: "A published apartment with its booked dates",
  description: "`bookedRanges` covers the booking horizon so a date picker can grey out taken nights; check-out days are free for a new check-in.",
  params: Type.Object({ slug: Slug }, { additionalProperties: false }),
  response: {
    200: Type.Object({ apartment: PublicApartment, bookedRanges: Type.Array(Type.Object({ checkIn: IsoDate, checkOut: IsoDate })) }),
    ...errorResponses(404, 422, 429),
  },
};

export const PublicImageSchema = {
  tags: ["public"],
  summary: "An apartment photo",
  description:
    "Served without login and cached for a year; photo ids are unguessable. Supports `If-None-Match`. Photos in a public R2 bucket redirect to Cloudflare's CDN; photos in a private bucket are streamed through the API.",
  params: ImageParams,
  response: {
    200: Type.Unsafe<Buffer>({ type: "string", format: "binary", description: "JPEG, PNG or WebP image" }),
    302: Type.Null({ description: "Redirect to the photo on the R2 public URL" }),
    304: Type.Null({ description: "Not modified" }),
    ...errorResponses(404, 422, 429, 502, 503),
  },
};
