import { addDays, nightsBetween } from "../../lib/dates.js";

/**
 * Reporting periods in business dates (YYYY-MM-DD, Africa/Lagos, both ends
 * inclusive). "This …" periods run to today; each period is compared with the
 * one before it (the same span of the previous week/month/quarter/year, or the
 * same number of days immediately before).
 */
export const RANGE_KEYS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "last_7_days",
  "this_month",
  "last_month",
  "last_30_days",
  "last_60_days",
  "last_90_days",
  "last_120_days",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "all_time",
  "custom",
] as const;

export type RangeKey = (typeof RANGE_KEYS)[number];
export type Granularity = "hour" | "day" | "week" | "month";
export type Period = { from: string; to: string };
export type ResolvedRange = Period & { key: RangeKey; days: number; granularity: Granularity; previous: Period | null };
export type Bucket = { start: string; end: string; hour?: number };

/** Longest custom range, and how far ahead one may reach (forward bookings). */
export const MAX_RANGE_DAYS = 3660;
export const MAX_FUTURE_DAYS = 366;

const LAST_N_DAYS = { last_7_days: 7, last_30_days: 30, last_60_days: 60, last_90_days: 90, last_120_days: 120 } as const;

function daysInclusive(from: string, to: string): number {
  return nightsBetween(from, to) + 1;
}

function addMonths(isoDate: string, months: number): string {
  const [year, month] = isoDate.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1 + months, 1)).toISOString().slice(0, 10);
}

/** Monday of the date's week. */
export function startOfWeek(isoDate: string): string {
  return addDays(isoDate, -((new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7));
}

export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 8)}01`;
}

function startOfMonths(isoDate: string, months: 3 | 12): string {
  const month = Number(isoDate.slice(5, 7)) - 1;
  return `${isoDate.slice(0, 5)}${String(month - (month % months) + 1).padStart(2, "0")}-01`;
}

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * A calendar period (`unit` = 7 days or 1/3/12 months) containing today
 * ("this", running to today) or the one before it ("last", complete).
 */
function calendar(today: string, start: string, shift: (date: string, units: number) => string, current: boolean): Period & { previous: Period } {
  if (current) {
    const previousFrom = shift(start, -1);
    return { from: start, to: today, previous: { from: previousFrom, to: earlier(addDays(previousFrom, nightsBetween(start, today)), addDays(start, -1)) } };
  }
  const from = shift(start, -1);
  return { from, to: addDays(start, -1), previous: { from: shift(start, -2), to: addDays(from, -1) } };
}

function granularityFor(days: number): Granularity {
  if (days <= 1) return "hour";
  if (days <= 62) return "day";
  if (days <= 190) return "week";
  return "month";
}

/** The immediately preceding period of the same length. */
function precedingPeriod(from: string, to: string): Period {
  const days = daysInclusive(from, to);
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

/**
 * Resolves a range key to dates. `earliest` is the first business date with any
 * records (for "all time"); `custom` takes `from`/`to`, validated by the caller
 * with `customRangeError`.
 */
export function resolveRange(key: RangeKey, today: string, options: { from?: string; to?: string; earliest?: string } = {}): ResolvedRange {
  const weeks = (date: string, units: number) => addDays(date, units * 7);
  const months = (count: number) => (date: string, units: number) => addMonths(date, units * count);
  let period: Period & { previous: Period | null };

  switch (key) {
    case "today":
      period = { from: today, to: today, previous: precedingPeriod(today, today) };
      break;
    case "yesterday": {
      const yesterday = addDays(today, -1);
      period = { from: yesterday, to: yesterday, previous: precedingPeriod(yesterday, yesterday) };
      break;
    }
    case "this_week":
    case "last_week":
      period = calendar(today, startOfWeek(today), weeks, key === "this_week");
      break;
    case "this_month":
    case "last_month":
      period = calendar(today, startOfMonth(today), months(1), key === "this_month");
      break;
    case "this_quarter":
    case "last_quarter":
      period = calendar(today, startOfMonths(today, 3), months(3), key === "this_quarter");
      break;
    case "this_year":
    case "last_year":
      period = calendar(today, startOfMonths(today, 12), months(12), key === "this_year");
      break;
    case "all_time":
      period = { from: earlier(options.earliest ?? today, today), to: today, previous: null };
      break;
    case "custom": {
      const from = options.from ?? today;
      const to = options.to ?? from;
      period = { from, to, previous: precedingPeriod(from, to) };
      break;
    }
    case "last_7_days":
    case "last_30_days":
    case "last_60_days":
    case "last_90_days":
    case "last_120_days": {
      const days = LAST_N_DAYS[key];
      const from = addDays(today, 1 - days);
      period = { from, to: today, previous: precedingPeriod(from, today) };
    }
  }

  const days = daysInclusive(period.from, period.to);
  return { key, ...period, days, granularity: granularityFor(days) };
}

/** Why a custom range is not acceptable, or null when it is. */
export function customRangeError(today: string, from: string | undefined, to: string | undefined): string | null {
  if (!from || !to) return "A custom range needs both from and to dates";
  if (from > to) return "The start date must be on or before the end date";
  if (daysInclusive(from, to) > MAX_RANGE_DAYS) return `A custom range can cover at most ${MAX_RANGE_DAYS} days`;
  if (to > addDays(today, MAX_FUTURE_DAYS)) return `A custom range can end at most ${MAX_FUTURE_DAYS} days from today`;
  return null;
}

/** Chart buckets covering the range: 24 hours for a single day, otherwise days, weeks (from Monday) or months, clipped to the range. */
export function bucketsFor(range: Pick<ResolvedRange, "from" | "to" | "granularity">): Bucket[] {
  const { from, to, granularity } = range;
  if (granularity === "hour") return Array.from({ length: 24 }, (_, hour) => ({ start: from, end: from, hour }));
  const buckets: Bucket[] = [];
  let start = from;
  while (start <= to) {
    const nextStart =
      granularity === "day" ? addDays(start, 1) : granularity === "week" ? addDays(startOfWeek(start), 7) : addMonths(startOfMonth(start), 1);
    buckets.push({ start, end: earlier(addDays(nextStart, -1), to) });
    start = later(nextStart, start);
  }
  return buckets;
}

/** Every business date in the range, in order. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}
