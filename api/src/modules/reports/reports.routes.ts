import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { withConnection, type Sql } from "../../db/sql.js";
import { BUSINESS_TIMEZONE, businessToday } from "../../lib/dates.js";
import { Errors } from "../../lib/errors.js";
import { IsoDate, KoboString, Nullable, StringEnum, Timestamp, errorResponses } from "../../lib/schemas.js";
import { requirePrincipal } from "../auth/principal.js";
import { RANGE_KEYS, bucketsFor, customRangeError, eachDay, resolveRange, type Period, type RangeKey } from "./report-ranges.js";

const TZ = BUSINESS_TIMEZONE;
/** Business date and hour of a timestamp column. */
const local = (column: string) => `(${column} AT TIME ZONE '${TZ}')::date::text AS day, extract(hour FROM ${column} AT TIME ZONE '${TZ}')::int AS hour`;
/** A timestamp column within business dates $2..$3 (inclusive). */
const within = (column: string) => `${column} >= ($2::date::timestamp AT TIME ZONE '${TZ}') AND ${column} < (($3::date + 1)::timestamp AT TIME ZONE '${TZ}')`;
const PAYMENT_TIME = "coalesce(settled_at, created_at)";
const POS_TIME = "coalesce(o.payment_confirmed_at, o.created_at)";
/** Reservations that occupy (or occupied) a room. */
const SOLD = "('confirmed', 'checked_in', 'checked_out')";
const SELLABLE_ROOM = "active AND status NOT IN ('maintenance', 'out_of_order')";
const TOP_ITEMS = 8;

const Summary = Type.Object({
  total_revenue_kobo: KoboString,
  room_revenue_kobo: KoboString,
  restaurant_revenue_kobo: KoboString,
  room_payments: Type.Integer(),
  bookings: Type.Integer({ description: "Reservations made in the period (abandoned online checkouts excluded)" }),
  booked_value_kobo: KoboString,
  booked_nights: Type.Integer(),
  cancelled: Type.Integer(),
  no_shows: Type.Integer(),
  abandoned_checkouts: Type.Integer({ description: "Online holds that expired unpaid" }),
  avg_stay_nights: Type.Number(),
  avg_lead_days: Type.Number(),
  nights_sold: Type.Integer(),
  available_nights: Type.Integer(),
  occupancy: Type.Number({ description: "nights_sold / available_nights, 0–1" }),
  stay_revenue_kobo: KoboString,
  adr_kobo: KoboString,
  revpar_kobo: KoboString,
  restaurant_orders: Type.Integer(),
  avg_order_kobo: KoboString,
  voided_orders: Type.Integer(),
  discounts_kobo: KoboString,
  new_guests: Type.Integer(),
  outstanding_kobo: KoboString,
});

const Point = Type.Object({
  start: IsoDate,
  end: IsoDate,
  hour: Type.Optional(Type.Integer()),
  room_revenue_kobo: KoboString,
  restaurant_revenue_kobo: KoboString,
  bookings: Type.Integer(),
  restaurant_orders: Type.Integer(),
  nights_sold: Nullable(Type.Integer()),
  occupancy: Nullable(Type.Number()),
});

const PeriodSchema = Type.Object({ from: IsoDate, to: IsoDate });

const ReportResponse = Type.Object({
  range: Type.Object({
    key: StringEnum(RANGE_KEYS),
    from: IsoDate,
    to: IsoDate,
    days: Type.Integer(),
    granularity: StringEnum(["hour", "day", "week", "month"] as const),
    previous: Nullable(PeriodSchema),
  }),
  summary: Summary,
  previous: Nullable(Summary),
  series: Type.Array(Point),
  breakdowns: Type.Object({
    payment_methods: Type.Array(Type.Object({ method: Type.String(), room_kobo: KoboString, restaurant_kobo: KoboString, count: Type.Integer() })),
    booking_sources: Type.Array(Type.Object({ source: Type.String(), bookings: Type.Integer(), value_kobo: KoboString })),
    booking_statuses: Type.Array(Type.Object({ status: Type.String(), bookings: Type.Integer() })),
    room_types: Type.Array(Type.Object({ room_type: Type.String(), rooms: Type.Integer(), nights: Type.Integer(), revenue_kobo: KoboString, occupancy: Type.Number(), adr_kobo: KoboString })),
    top_items: Type.Array(Type.Object({ name: Type.String(), quantity: Type.Integer(), revenue_kobo: KoboString })),
    weekdays: Type.Array(Type.Object({ weekday: Type.Integer({ description: "1 = Monday … 7 = Sunday" }), occupancy: Type.Number(), nights: Type.Integer() })),
  }),
  rooms_in_service: Type.Integer(),
  generatedAt: Timestamp,
});

type TimedRow = { day: string; hour: number };
type PaymentRow = TimedRow & { method: string; kobo: string; count: number };
type PosRow = TimedRow & { method: string; kobo: string; discount: string; count: number };
type BookingRow = TimedRow & { source: string; status: string; count: number; value: string; nights: number; lead_days: number };
type NightRow = { day: string; room_type: string; nights: number; revenue: number };

type Raw = {
  payments: PaymentRow[];
  pos: PosRow[];
  bookings: BookingRow[];
  nights: NightRow[];
  rooms: Array<{ room_type: string; rooms: number }>;
  extras: { voided: number; new_guests: number; outstanding: string };
  topItems: Array<{ name: string; quantity: number; revenue_kobo: string }>;
};

/** Every query reads committed records only; amounts are integer kobo. */
async function collect(sql: Sql, propertyId: string, period: Period, withTopItems: boolean): Promise<Raw> {
  const params = [propertyId, period.from, period.to];
  const payments = await sql.rows<PaymentRow>(
    `SELECT ${local(PAYMENT_TIME)}, method, sum(amount_kobo)::text AS kobo, count(*)::int AS count
       FROM payments WHERE property_id = $1 AND status = 'settled' AND ${within(PAYMENT_TIME)}
      GROUP BY 1, 2, 3`,
    params,
  );
  const pos = await sql.rows<PosRow>(
    `SELECT ${local(POS_TIME)}, o.payment_method AS method, sum(o.total_kobo)::text AS kobo, sum(o.discount_kobo)::text AS discount, count(*)::int AS count
       FROM pos_orders o WHERE o.property_id = $1 AND o.status = 'paid' AND o.payment_status = 'settled' AND ${within(POS_TIME)}
      GROUP BY 1, 2, 3`,
    params,
  );
  const bookings = await sql.rows<BookingRow>(
    `SELECT ${local("created_at")}, source, status, count(*)::int AS count, sum(amount_kobo)::text AS value,
            sum(check_out - check_in)::int AS nights, sum(greatest(check_in - (created_at AT TIME ZONE '${TZ}')::date, 0))::int AS lead_days
       FROM reservations WHERE property_id = $1 AND ${within("created_at")}
      GROUP BY 1, 2, 3, 4`,
    params,
  );
  // One row per occupied room-night; the stay's price is spread evenly over its nights.
  const nights = await sql.rows<NightRow>(
    `SELECT night::date::text AS day, r.room_type, count(*)::int AS nights,
            sum(r.amount_kobo::numeric / greatest(r.check_out - r.check_in, 1))::float8 AS revenue
       FROM reservations r
       CROSS JOIN LATERAL generate_series(greatest(r.check_in, $2::date), least(r.check_out - 1, $3::date), interval '1 day') AS night
      WHERE r.property_id = $1 AND r.status IN ${SOLD} AND r.check_in <= $3::date AND r.check_out > $2::date
      GROUP BY 1, 2`,
    params,
  );
  const rooms = await sql.rows<{ room_type: string; rooms: number }>(
    `SELECT room_type, count(*)::int AS rooms FROM rooms WHERE property_id = $1 AND ${SELLABLE_ROOM} GROUP BY room_type ORDER BY room_type`,
    [propertyId],
  );
  const extras = await sql.one<Raw["extras"]>(
    `SELECT
       (SELECT count(*)::int FROM pos_orders WHERE property_id = $1 AND status = 'voided' AND ${within("created_at")}) AS voided,
       (SELECT count(*)::int FROM guests WHERE property_id = $1 AND ${within("created_at")}) AS new_guests,
       (SELECT coalesce(sum(greatest(r.amount_kobo + r.extra_charges_kobo - coalesce(paid.kobo, 0), 0)), 0)::text
          FROM reservations r
          LEFT JOIN LATERAL (SELECT sum(amount_kobo) AS kobo FROM payments WHERE reservation_id = r.id AND status = 'settled') paid ON true
         WHERE r.property_id = $1 AND r.status IN ${SOLD} AND r.check_in BETWEEN $2::date AND $3::date) AS outstanding`,
    params,
  );
  const topItems = withTopItems
    ? await sql.rows<Raw["topItems"][number]>(
        `SELECT i.item_name AS name, sum(i.quantity)::int AS quantity, sum(i.line_total_kobo)::text AS revenue_kobo
           FROM pos_order_items i JOIN pos_orders o ON o.id = i.order_id
          WHERE o.property_id = $1 AND o.status = 'paid' AND o.payment_status = 'settled' AND ${within(POS_TIME)}
          GROUP BY 1 ORDER BY sum(i.line_total_kobo) DESC, 1 LIMIT ${TOP_ITEMS}`,
        params,
      )
    : [];
  return { payments, pos, bookings, nights, rooms, extras, topItems };
}

const sum = <T>(rows: readonly T[], pick: (row: T) => number | string) => rows.reduce((total, row) => total + Number(pick(row)), 0);
const kobo = (value: number) => String(Math.round(value));
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;
/** Reservations that count as bookings: everything except online holds that were never paid. */
const isBooking = (row: BookingRow) => row.status !== "hold" && row.status !== "expired";

function summarize(raw: Raw, period: Period) {
  const roomsInService = sum(raw.rooms, (row) => row.rooms);
  const availableNights = roomsInService * eachDay(period.from, period.to).length;
  const roomRevenue = sum(raw.payments, (row) => row.kobo);
  const restaurantRevenue = sum(raw.pos, (row) => row.kobo);
  const restaurantOrders = sum(raw.pos, (row) => row.count);
  const booked = raw.bookings.filter(isBooking);
  const bookings = sum(booked, (row) => row.count);
  const bookedNights = sum(booked, (row) => row.nights);
  const nightsSold = sum(raw.nights, (row) => row.nights);
  const stayRevenue = sum(raw.nights, (row) => row.revenue);
  const byStatus = (status: string) => sum(booked.filter((row) => row.status === status), (row) => row.count);
  return {
    total_revenue_kobo: kobo(roomRevenue + restaurantRevenue),
    room_revenue_kobo: kobo(roomRevenue),
    restaurant_revenue_kobo: kobo(restaurantRevenue),
    room_payments: sum(raw.payments, (row) => row.count),
    bookings,
    booked_value_kobo: kobo(sum(booked, (row) => row.value)),
    booked_nights: bookedNights,
    cancelled: byStatus("cancelled"),
    no_shows: byStatus("no_show"),
    abandoned_checkouts: sum(raw.bookings.filter((row) => row.status === "expired"), (row) => row.count),
    avg_stay_nights: round(ratio(bookedNights, bookings)),
    avg_lead_days: round(ratio(sum(booked, (row) => row.lead_days), bookings)),
    nights_sold: nightsSold,
    available_nights: availableNights,
    occupancy: round(ratio(nightsSold, availableNights), 4),
    stay_revenue_kobo: kobo(stayRevenue),
    adr_kobo: kobo(ratio(stayRevenue, nightsSold)),
    revpar_kobo: kobo(ratio(stayRevenue, availableNights)),
    restaurant_orders: restaurantOrders,
    avg_order_kobo: kobo(ratio(restaurantRevenue, restaurantOrders)),
    voided_orders: raw.extras.voided,
    discounts_kobo: kobo(sum(raw.pos, (row) => row.discount)),
    new_guests: raw.extras.new_guests,
    outstanding_kobo: raw.extras.outstanding,
  };
}

function breakdowns(raw: Raw, period: Period) {
  const methods = new Map<string, { room: number; restaurant: number; count: number }>();
  const method = (key: string) => methods.get(key) ?? methods.set(key, { room: 0, restaurant: 0, count: 0 }).get(key)!;
  for (const row of raw.payments) {
    const entry = method(row.method);
    entry.room += Number(row.kobo);
    entry.count += row.count;
  }
  for (const row of raw.pos) {
    const entry = method(row.method);
    entry.restaurant += Number(row.kobo);
    entry.count += row.count;
  }

  const booked = raw.bookings.filter(isBooking);
  const sources = new Map<string, { bookings: number; value: number }>();
  for (const row of booked) {
    const entry = sources.get(row.source) ?? { bookings: 0, value: 0 };
    sources.set(row.source, { bookings: entry.bookings + row.count, value: entry.value + Number(row.value) });
  }
  const statuses = new Map<string, number>();
  for (const row of raw.bookings) statuses.set(row.status, (statuses.get(row.status) ?? 0) + row.count);

  const days = eachDay(period.from, period.to);
  const roomsByType = new Map(raw.rooms.map((row) => [row.room_type, row.rooms]));
  const types = new Map<string, { nights: number; revenue: number }>();
  for (const row of raw.nights) {
    const entry = types.get(row.room_type) ?? { nights: 0, revenue: 0 };
    types.set(row.room_type, { nights: entry.nights + row.nights, revenue: entry.revenue + row.revenue });
  }
  for (const type of roomsByType.keys()) if (!types.has(type)) types.set(type, { nights: 0, revenue: 0 });

  const roomsInService = sum(raw.rooms, (row) => row.rooms);
  const nightsByDay = new Map<string, number>();
  for (const row of raw.nights) nightsByDay.set(row.day, (nightsByDay.get(row.day) ?? 0) + row.nights);
  const weekdays = Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, nights: 0, days: 0 }));
  for (const day of days) {
    const entry = weekdays[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;
    entry.days += 1;
    entry.nights += nightsByDay.get(day) ?? 0;
  }

  return {
    payment_methods: [...methods]
      .map(([key, value]) => ({ method: key, room_kobo: kobo(value.room), restaurant_kobo: kobo(value.restaurant), count: value.count }))
      .sort((a, b) => Number(b.room_kobo) + Number(b.restaurant_kobo) - Number(a.room_kobo) - Number(a.restaurant_kobo)),
    booking_sources: [...sources].map(([source, value]) => ({ source, bookings: value.bookings, value_kobo: kobo(value.value) })).sort((a, b) => b.bookings - a.bookings),
    booking_statuses: [...statuses].map(([status, bookings]) => ({ status, bookings })).sort((a, b) => b.bookings - a.bookings),
    room_types: [...types]
      .map(([roomType, value]) => {
        const rooms = roomsByType.get(roomType) ?? 0;
        return { room_type: roomType, rooms, nights: value.nights, revenue_kobo: kobo(value.revenue), occupancy: round(ratio(value.nights, rooms * days.length), 4), adr_kobo: kobo(ratio(value.revenue, value.nights)) };
      })
      .sort((a, b) => Number(b.revenue_kobo) - Number(a.revenue_kobo) || a.room_type.localeCompare(b.room_type)),
    top_items: raw.topItems,
    weekdays: weekdays.map(({ weekday, nights, days: count }) => ({ weekday, nights, occupancy: round(ratio(nights, roomsInService * count), 4) })),
  };
}

function series(raw: Raw, range: ReturnType<typeof resolveRange>) {
  const buckets = bucketsFor(range);
  const hourly = range.granularity === "hour";
  const index = new Map<string, number>();
  if (hourly) buckets.forEach((bucket, position) => index.set(`${bucket.start}:${bucket.hour}`, position));
  else buckets.forEach((bucket, position) => eachDay(bucket.start, bucket.end).forEach((day) => index.set(day, position)));
  const slot = (row: TimedRow) => index.get(hourly ? `${row.day}:${row.hour}` : row.day);

  const points = buckets.map((bucket) => ({ ...bucket, room: 0, restaurant: 0, bookings: 0, orders: 0, nights: 0 }));
  for (const row of raw.payments) {
    const at = slot(row);
    if (at !== undefined) points[at]!.room += Number(row.kobo);
  }
  for (const row of raw.pos) {
    const at = slot(row);
    if (at === undefined) continue;
    points[at]!.restaurant += Number(row.kobo);
    points[at]!.orders += row.count;
  }
  for (const row of raw.bookings.filter(isBooking)) {
    const at = slot(row);
    if (at !== undefined) points[at]!.bookings += row.count;
  }
  if (!hourly) {
    for (const row of raw.nights) {
      const at = index.get(row.day);
      if (at !== undefined) points[at]!.nights += row.nights;
    }
  }
  const roomsInService = sum(raw.rooms, (row) => row.rooms);
  return points.map((point) => ({
    start: point.start,
    end: point.end,
    ...(point.hour === undefined ? {} : { hour: point.hour }),
    room_revenue_kobo: kobo(point.room),
    restaurant_revenue_kobo: kobo(point.restaurant),
    bookings: point.bookings,
    restaurant_orders: point.orders,
    nights_sold: hourly ? null : point.nights,
    occupancy: hourly ? null : round(ratio(point.nights, roomsInService * eachDay(point.start, point.end).length), 4),
  }));
}

const reportRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    "/",
    {
      preHandler: app.authorize("reports:read"),
      schema: {
        tags: ["reports"],
        summary: "Performance report for a period: KPIs, comparison with the previous period, a time series and breakdowns",
        description:
          "Periods are Africa/Lagos business dates. Revenue is settled money (room payments by settlement time, restaurant orders by confirmation time). Room-nights and stay revenue come from confirmed, in-house and completed stays, with each stay's price spread evenly over its nights. Occupancy is measured against the rooms in service today.",
        security: [{ bearerAuth: [] }],
        querystring: Type.Object(
          {
            range: Type.Optional(StringEnum(RANGE_KEYS, { description: "Default last_30_days" })),
            from: Type.Optional(IsoDate),
            to: Type.Optional(IsoDate),
          },
          { additionalProperties: false },
        ),
        response: { 200: ReportResponse, ...errorResponses(401, 403, 422) },
      },
    },
    async (request) => {
      const propertyId = requirePrincipal(request).propertyId;
      const key: RangeKey = request.query.range ?? "last_30_days";
      const today = businessToday();
      if (key === "custom") {
        const problem = customRangeError(today, request.query.from, request.query.to);
        if (problem) throw Errors.unprocessable(problem, "INVALID_RANGE");
      }

      return withConnection(app.db, async (sql) => {
        const earliest =
          key === "all_time"
            ? (
                await sql.one<{ earliest: string | null }>(
                  `SELECT least(
                     (SELECT (created_at AT TIME ZONE '${TZ}')::date FROM properties WHERE id = $1),
                     (SELECT min(check_in) FROM reservations WHERE property_id = $1),
                     (SELECT min((created_at AT TIME ZONE '${TZ}')::date) FROM payments WHERE property_id = $1),
                     (SELECT min((created_at AT TIME ZONE '${TZ}')::date) FROM pos_orders WHERE property_id = $1))::text AS earliest`,
                  [propertyId],
                )
              ).earliest ?? today
            : undefined;
        const range = resolveRange(key, today, { from: request.query.from, to: request.query.to, earliest });
        const current = await collect(sql, propertyId, range, true);
        const previous = range.previous ? summarize(await collect(sql, propertyId, range.previous, false), range.previous) : null;

        return {
          range: { key: range.key, from: range.from, to: range.to, days: range.days, granularity: range.granularity, previous: range.previous },
          summary: summarize(current, range),
          previous,
          series: series(current, range),
          breakdowns: breakdowns(current, range),
          rooms_in_service: sum(current.rooms, (row) => row.rooms),
          generatedAt: new Date(),
        };
      });
    },
  );
};

export default reportRoutes;
