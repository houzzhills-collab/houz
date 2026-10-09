import { describe, expect, it } from "vitest";
import { bucketsFor, customRangeError, resolveRange, startOfWeek } from "../../src/modules/reports/report-ranges.js";

// Thursday 9 October 2026.
const TODAY = "2026-10-09";

describe("report ranges", () => {
  it("resolves single days, hourly, against the day before", () => {
    expect(resolveRange("today", TODAY)).toMatchObject({ from: TODAY, to: TODAY, days: 1, granularity: "hour", previous: { from: "2026-10-08", to: "2026-10-08" } });
    expect(resolveRange("yesterday", TODAY)).toMatchObject({ from: "2026-10-08", to: "2026-10-08", previous: { from: "2026-10-07", to: "2026-10-07" } });
  });

  it("starts weeks on Monday and compares this week with the same days last week", () => {
    expect(startOfWeek(TODAY)).toBe("2026-10-05");
    expect(startOfWeek("2026-10-11")).toBe("2026-10-05");
    expect(resolveRange("this_week", TODAY)).toMatchObject({ from: "2026-10-05", to: TODAY, days: 5, granularity: "day", previous: { from: "2026-09-28", to: "2026-10-02" } });
    expect(resolveRange("last_week", TODAY)).toMatchObject({ from: "2026-09-28", to: "2026-10-04", days: 7, previous: { from: "2026-09-21", to: "2026-09-27" } });
  });

  it("compares calendar months, clamping to the shorter month", () => {
    expect(resolveRange("this_month", TODAY)).toMatchObject({ from: "2026-10-01", to: TODAY, previous: { from: "2026-09-01", to: "2026-09-09" } });
    expect(resolveRange("last_month", TODAY)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", days: 30, previous: { from: "2026-08-01", to: "2026-08-31" } });
    expect(resolveRange("this_month", "2026-03-31").previous).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("resolves quarters and years", () => {
    expect(resolveRange("this_quarter", TODAY)).toMatchObject({ from: "2026-10-01", to: TODAY, previous: { from: "2026-07-01", to: "2026-07-09" } });
    expect(resolveRange("last_quarter", TODAY)).toMatchObject({ from: "2026-07-01", to: "2026-09-30", granularity: "week" });
    expect(resolveRange("this_year", TODAY)).toMatchObject({ from: "2026-01-01", to: TODAY, granularity: "month", previous: { from: "2025-01-01", to: "2025-10-09" } });
    expect(resolveRange("last_year", TODAY)).toMatchObject({ from: "2025-01-01", to: "2025-12-31", days: 365, previous: { from: "2024-01-01", to: "2024-12-31" } });
  });

  it("resolves rolling day counts against the days just before", () => {
    expect(resolveRange("last_30_days", TODAY)).toMatchObject({ from: "2026-09-10", to: TODAY, days: 30, granularity: "day", previous: { from: "2026-08-11", to: "2026-09-09" } });
    expect(resolveRange("last_90_days", TODAY)).toMatchObject({ days: 90, granularity: "week" });
    expect(resolveRange("last_120_days", TODAY)).toMatchObject({ from: "2026-06-12", days: 120 });
  });

  it("runs all time from the first record, with no comparison", () => {
    expect(resolveRange("all_time", TODAY, { earliest: "2024-05-17" })).toMatchObject({ from: "2024-05-17", to: TODAY, granularity: "month", previous: null });
    expect(resolveRange("all_time", TODAY)).toMatchObject({ from: TODAY, to: TODAY });
  });

  it("validates custom ranges", () => {
    expect(customRangeError(TODAY, "2026-10-01", "2026-10-05")).toBeNull();
    expect(customRangeError(TODAY, "2026-10-05", undefined)).toMatch(/both/);
    expect(customRangeError(TODAY, "2026-10-05", "2026-10-01")).toMatch(/on or before/);
    expect(customRangeError(TODAY, "2000-01-01", TODAY)).toMatch(/at most/);
    expect(customRangeError(TODAY, TODAY, "2028-01-01")).toMatch(/from today/);
    expect(resolveRange("custom", TODAY, { from: "2026-10-01", to: "2026-10-05" }).previous).toEqual({ from: "2026-09-26", to: "2026-09-30" });
  });

  it("builds buckets clipped to the range", () => {
    expect(bucketsFor({ from: TODAY, to: TODAY, granularity: "hour" })).toHaveLength(24);
    expect(bucketsFor({ from: "2026-10-01", to: "2026-10-03", granularity: "day" }).map((bucket) => bucket.start)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(bucketsFor({ from: "2026-07-01", to: "2026-07-20", granularity: "week" })).toEqual([
      { start: "2026-07-01", end: "2026-07-05" },
      { start: "2026-07-06", end: "2026-07-12" },
      { start: "2026-07-13", end: "2026-07-19" },
      { start: "2026-07-20", end: "2026-07-20" },
    ]);
    expect(bucketsFor({ from: "2025-11-15", to: "2026-02-03", granularity: "month" })).toEqual([
      { start: "2025-11-15", end: "2025-11-30" },
      { start: "2025-12-01", end: "2025-12-31" },
      { start: "2026-01-01", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-03" },
    ]);
  });
});
