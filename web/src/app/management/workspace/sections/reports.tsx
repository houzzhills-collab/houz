"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, BedDouble, CalendarDays, CalendarRange, Check, ChevronDown, CircleDollarSign, Download, Minus, ReceiptText, TriangleAlert, Utensils, Wallet } from "lucide-react";
import { api, type Report, type ReportPoint, type ReportQuery, type ReportRangeKey, type ReportSummary } from "@/lib/api";
import { compactMoney, humanize, money, optionLabel, propertyDate } from "../format";
import { BarList, ColumnChart, Legend, LineChart, type ChartDatum, type ChartSeries } from "../charts";
import { Empty, InlineError, Tip, download, useResource, type SectionProps } from "../ui";

const PRESET_GROUPS: ReadonlyArray<{ title: string; presets: ReadonlyArray<{ key: Exclude<ReportRangeKey, "custom">; label: string }> }> = [
  { title: "Days", presets: [{ key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" }, { key: "last_7_days", label: "Last 7 days" }] },
  { title: "Weeks", presets: [{ key: "this_week", label: "This week" }, { key: "last_week", label: "Last week" }] },
  { title: "Months", presets: [{ key: "this_month", label: "This month" }, { key: "last_month", label: "Last month" }] },
  {
    title: "Rolling",
    presets: [
      { key: "last_30_days", label: "Last 30 days" },
      { key: "last_60_days", label: "Last 60 days" },
      { key: "last_90_days", label: "Last 90 days" },
      { key: "last_120_days", label: "Last 120 days" },
    ],
  },
  { title: "Quarters", presets: [{ key: "this_quarter", label: "This quarter" }, { key: "last_quarter", label: "Last quarter" }] },
  { title: "Years", presets: [{ key: "this_year", label: "This year" }, { key: "last_year", label: "Last year" }, { key: "all_time", label: "All time" }] },
];
const PRESET_LABELS = new Map<ReportRangeKey, string>([...PRESET_GROUPS.flatMap((group) => group.presets.map((preset) => [preset.key, preset.label] as const)), ["custom", "Custom range"]]);
const STORAGE_KEY = "hh.reports.range";
const DEFAULT_QUERY: ReportQuery = { range: "last_30_days" };

/** Categorical colours (validated for colour-vision deficiency): rooms, restaurant. */
const ROOMS: ChartSeries = { name: "Rooms", color: "#a8812f" };
const RESTAURANT: ChartSeries = { name: "Restaurant", color: "#2a78d6" };
const BOOKINGS: ChartSeries = { name: "Bookings", color: "#a8812f" };
const OCCUPANCY: ChartSeries = { name: "Occupancy", color: "#a8812f" };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SOURCE_LABELS: Record<string, string> = { staff: "Front desk", public_website: "Website" };
const GRANULARITY_LABELS: Record<Report["range"]["granularity"], string> = { hour: "by hour", day: "by day", week: "by week (from Monday)", month: "by month" };

const count = new Intl.NumberFormat("en-NG");
const percent = (ratio: number, digits = 0) => `${(ratio * 100).toFixed(digits)}%`;
const naira = (kobo: number) => money(kobo);

function fullDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-NG", { day: "numeric", month: "short", timeZone: "UTC" });
}
function periodLabel(period: { from: string; to: string }): string {
  return period.from === period.to ? fullDate(period.from) : `${fullDate(period.from)} – ${fullDate(period.to)}`;
}

function pointLabels(point: ReportPoint, granularity: Report["range"]["granularity"]): { label: string; detail: string } {
  if (point.hour !== undefined) {
    const hour = String(point.hour).padStart(2, "0");
    return { label: `${hour}:00`, detail: `${hour}:00–${hour}:59, ${shortDate(point.start)}` };
  }
  if (granularity === "day") {
    return { label: shortDate(point.start), detail: new Date(`${point.start}T12:00:00Z`).toLocaleDateString("en-NG", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) };
  }
  const label = granularity === "month" ? new Date(`${point.start}T12:00:00Z`).toLocaleDateString("en-NG", { month: "short", year: "2-digit", timeZone: "UTC" }) : shortDate(point.start);
  return { label, detail: point.start === point.end ? fullDate(point.start) : `${shortDate(point.start)} – ${fullDate(point.end)}` };
}

function loadQuery(): ReportQuery {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as ReportQuery | null;
    return saved && PRESET_LABELS.has(saved.range) ? saved : DEFAULT_QUERY;
  } catch {
    return DEFAULT_QUERY;
  }
}

/** The change against the previous period. `goodWhen` says which direction is good news. */
function Delta({ current, previous, goodWhen = "up", points = false, label }: { current: number; previous: number | null; goodWhen?: "up" | "down"; points?: boolean; label: string }) {
  if (previous === null) return null;
  const change = current - previous;
  if (change === 0 || (!points && previous === 0 && current === 0)) {
    return (
      <span className="report-delta" data-tip={`Same as ${label}`}>
        <Minus size={13} /> No change
      </span>
    );
  }
  const ratio = previous === 0 ? 0 : change / previous;
  const text = points
    ? `${change > 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(1)} pts`
    : previous === 0
      ? "New"
      : ratio >= 10
        ? `${Math.round(current / previous)}×`
        : `${change > 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(Math.abs(ratio) < 0.1 ? 1 : 0)}%`;
  const good = (change > 0) === (goodWhen === "up");
  return (
    <span className={`report-delta ${good ? "is-good" : "is-bad"}`} data-tip={`Compared with ${label}`}>
      {change > 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {text}
    </span>
  );
}

function StatTile({ label, icon, tip, value, delta, foot }: { label: string; icon: ReactNode; tip: string; value: string; delta: ReactNode; foot: string }) {
  return (
    <article className="report-stat">
      <div className="report-stat-top">
        <span data-tip={tip}>{label}</span>
        {icon}
      </div>
      <strong>{value}</strong>
      <div className="report-stat-foot">
        {delta}
        <small>{foot}</small>
      </div>
    </article>
  );
}

function RangePicker({ query, onChange }: { query: ReportQuery; onChange: (query: ReportQuery) => void }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(query.from ?? propertyDate(-29));
  const [to, setTo] = useState(query.to ?? propertyDate(0));
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => !root.current?.contains(event.target as Node) && setOpen(false);
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const choose = (next: ReportQuery) => {
    onChange(next);
    setOpen(false);
  };
  const customValid = Boolean(from && to && from <= to);

  return (
    <div className="range-picker" ref={root}>
      <button className="range-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <CalendarRange size={15} />
        <span>{PRESET_LABELS.get(query.range)}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="range-popover" role="dialog" aria-label="Choose a reporting period">
          <div className="range-groups">
            {PRESET_GROUPS.map((group) => (
              <div key={group.title}>
                <small>{group.title}</small>
                {group.presets.map((preset) => (
                  <button key={preset.key} className={query.range === preset.key ? "is-selected" : ""} onClick={() => choose({ range: preset.key })}>
                    <span>{preset.label}</span>
                    {query.range === preset.key && <Check size={16} strokeWidth={2.6} />}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <form
            className="range-custom"
            onSubmit={(event) => {
              event.preventDefault();
              if (customValid) choose({ range: "custom", from, to });
            }}
          >
            <small>Custom range</small>
            <div>
              <input type="date" aria-label="From" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} required />
              <span>to</span>
              <input type="date" aria-label="To" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} required />
              <button className="button-primary" disabled={!customValid}>
                Apply
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function Panel({ title, tip, subtitle, actions, children, className = "" }: { title: string; tip: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <article className={`panel report-panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>
            {title}
            <Tip text={tip} />
          </h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </article>
  );
}

function exportCsv(report: Report, propertyName: string) {
  const header = ["Period start", "Period end", ...(report.range.granularity === "hour" ? ["Hour"] : []), "Room revenue (NGN)", "Restaurant revenue (NGN)", "Total revenue (NGN)", "Bookings made", "Restaurant orders", "Room-nights sold", "Occupancy (%)"];
  const lines = report.series.map((point) => [
    point.start,
    point.end,
    ...(point.hour !== undefined ? [`${String(point.hour).padStart(2, "0")}:00`] : []),
    (Number(point.room_revenue_kobo) / 100).toFixed(2),
    (Number(point.restaurant_revenue_kobo) / 100).toFixed(2),
    ((Number(point.room_revenue_kobo) + Number(point.restaurant_revenue_kobo)) / 100).toFixed(2),
    point.bookings,
    point.restaurant_orders,
    point.nights_sold ?? "",
    point.occupancy === null ? "" : (point.occupancy * 100).toFixed(1),
  ]);
  const csv = [header, ...lines].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const slug = propertyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  download(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }), `${slug || "property"}-report-${report.range.from}-to-${report.range.to}.csv`);
}

function SeriesTable({ report }: { report: Report }) {
  const hourly = report.range.granularity === "hour";
  return (
    <div className="table-scroll report-series-table">
      <table>
        <thead>
          <tr>
            <th>Period</th>
            <th>Rooms</th>
            <th>Restaurant</th>
            <th>Total</th>
            <th>Bookings</th>
            <th>Orders</th>
            {!hourly && <th>Room-nights</th>}
            {!hourly && <th>Occupancy</th>}
          </tr>
        </thead>
        <tbody>
          {report.series.map((point) => (
            <tr key={`${point.start}:${point.hour ?? ""}`}>
              <td>{pointLabels(point, report.range.granularity).detail}</td>
              <td>{money(point.room_revenue_kobo)}</td>
              <td>{money(point.restaurant_revenue_kobo)}</td>
              <td>{money(Number(point.room_revenue_kobo) + Number(point.restaurant_revenue_kobo))}</td>
              <td>{point.bookings}</td>
              <td>{point.restaurant_orders}</td>
              {!hourly && <td>{point.nights_sold}</td>}
              {!hourly && <td>{point.occupancy === null ? "—" : percent(point.occupancy, 1)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsSection({ refreshKey, reference, property }: SectionProps) {
  // Sections mount only in the browser, after sign-in, so the saved period can be read straight away.
  const [query, setQuery] = useState<ReportQuery>(loadQuery);
  const [view, setView] = useState<"chart" | "table">("chart");
  const queryKey = `${query.range}:${query.from ?? ""}:${query.to ?? ""}`;
  const report = useResource<Report>(() => api.reports.get(query), `${refreshKey}:${queryKey}`);
  const data = report.data;
  const stale = data !== null && (data.range.key !== query.range || (query.range === "custom" && (data.range.from !== query.from || data.range.to !== query.to)));

  const change = (next: ReportQuery) => {
    setQuery(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const chartData = useMemo(() => {
    if (!data) return null;
    const labelled = data.series.map((point) => ({ point, ...pointLabels(point, data.range.granularity) }));
    const datum = (values: (point: ReportPoint) => Array<number | null>): ChartDatum[] => labelled.map(({ point, label, detail }) => ({ label, detail, values: values(point) }));
    return {
      revenue: datum((point) => [Number(point.room_revenue_kobo), Number(point.restaurant_revenue_kobo)]),
      bookings: datum((point) => [point.bookings]),
      occupancy: datum((point) => [point.occupancy]),
      weekdays: data.breakdowns.weekdays.map((day) => ({ label: WEEKDAYS[day.weekday - 1] ?? "", detail: `${WEEKDAYS[day.weekday - 1]} · ${count.format(day.nights)} room-nights`, values: [day.occupancy] })),
    };
  }, [data]);

  const picker = (
    <div className="report-filters">
      <RangePicker key={queryKey} query={query} onChange={change} />
      {data && (
        <span className="report-period">
          <CalendarDays size={14} />
          {periodLabel(data.range)}
          {data.range.previous && <em>vs {periodLabel(data.range.previous)}</em>}
        </span>
      )}
      <button className="filter-button report-export" disabled={!data} onClick={() => data && exportCsv(data, property.name)} data-tip="Download the figures below as a spreadsheet (CSV)">
        <Download size={14} /> Export CSV
      </button>
    </div>
  );

  if (!data || !chartData) {
    return (
      <>
        {picker}
        <InlineError message={report.error} />
        {!report.error && <Empty text="Preparing your report…" />}
      </>
    );
  }

  const s = data.summary;
  const p = data.previous;
  const previousLabel = data.range.previous ? periodLabel(data.range.previous) : "";
  const delta = (pick: (summary: ReportSummary) => number | string, options: { goodWhen?: "up" | "down"; points?: boolean } = {}) => (
    <Delta current={Number(pick(s))} previous={p ? Number(pick(p)) : null} label={previousLabel} {...options} />
  );
  const hourly = data.range.granularity === "hour";
  const lostBookings = s.cancelled + s.no_shows;
  const totalPayments = data.breakdowns.payment_methods.reduce((total, row) => total + Number(row.room_kobo) + Number(row.restaurant_kobo), 0);
  const allBookings = data.breakdowns.booking_statuses.reduce((total, row) => total + row.bookings, 0);

  return (
    <div className={`report ${stale ? "is-refreshing" : ""}`} aria-busy={stale}>
      {picker}
      <InlineError message={report.error} />

      <section className="report-stats" aria-label="Key figures">
        <StatTile label="Total revenue" icon={<CircleDollarSign size={17} />} tip="Money settled in the period: room payments plus paid restaurant orders. Pending transfers and failed payments are not included." value={money(s.total_revenue_kobo)} delta={delta((x) => x.total_revenue_kobo)} foot={`Rooms ${money(s.room_revenue_kobo)} · Restaurant ${money(s.restaurant_revenue_kobo)}`} />
        <StatTile label="Occupancy" icon={<BedDouble size={17} />} tip="Room-nights sold divided by room-nights available. Available nights use the rooms in service today; rooms under maintenance are excluded." value={percent(s.occupancy, 1)} delta={delta((x) => x.occupancy, { points: true })} foot={`${count.format(s.nights_sold)} of ${count.format(s.available_nights)} room-nights`} />
        <StatTile label="Average daily rate" icon={<Wallet size={17} />} tip="ADR: the average price of an occupied room-night. Each stay's price is spread evenly over its nights." value={money(s.adr_kobo)} delta={delta((x) => x.adr_kobo)} foot={`RevPAR ${money(s.revpar_kobo)} per available night`} />
        <StatTile label="Bookings made" icon={<CalendarDays size={17} />} tip="Reservations created in the period, from the front desk and the website. Online checkouts that expired unpaid are not counted." value={count.format(s.bookings)} delta={delta((x) => x.bookings)} foot={`${count.format(s.booked_nights)} nights · ${money(s.booked_value_kobo)} booked`} />
        <StatTile label="Restaurant sales" icon={<Utensils size={17} />} tip="Paid and settled restaurant orders. Voided orders and transfers awaiting confirmation are not included." value={money(s.restaurant_revenue_kobo)} delta={delta((x) => x.restaurant_revenue_kobo)} foot={`${count.format(s.restaurant_orders)} orders · ${money(s.avg_order_kobo)} average`} />
        <StatTile label="Stay revenue" icon={<ReceiptText size={17} />} tip="The value of the room-nights guests stayed in this period (earned revenue), whether or not it has been paid yet." value={money(s.stay_revenue_kobo)} delta={delta((x) => x.stay_revenue_kobo)} foot={`${count.format(s.nights_sold)} room-nights stayed`} />
        <StatTile label="Cancellations and no-shows" icon={<TriangleAlert size={17} />} tip="Bookings made in this period that were later cancelled or marked as no-show." value={count.format(lostBookings)} delta={delta((x) => x.cancelled + x.no_shows, { goodWhen: "down" })} foot={`${s.bookings ? percent(lostBookings / s.bookings) : "0%"} of bookings · ${s.cancelled} cancelled, ${s.no_shows} no-show`} />
        <StatTile label="Outstanding balance" icon={<Wallet size={17} />} tip="Unpaid amounts on confirmed stays arriving in this period: the booking value minus settled payments." value={money(s.outstanding_kobo)} delta={delta((x) => x.outstanding_kobo, { goodWhen: "down" })} foot="On stays arriving in this period" />
      </section>

      <section className="live-kpi-row report-kpi-row" aria-label="More figures">
        <div data-tip="Guest records created in the period.">
          <small>New guests</small>
          <strong>{count.format(s.new_guests)}</strong>
        </div>
        <div data-tip="Average nights per booking made in the period.">
          <small>Average stay</small>
          <strong>{s.avg_stay_nights} nights</strong>
        </div>
        <div data-tip="Average days between making a booking and arriving.">
          <small>Booking lead time</small>
          <strong>{s.avg_lead_days} days</strong>
        </div>
        <div data-tip="Online checkouts started on the website and abandoned before payment, so the hold expired.">
          <small>Abandoned checkouts</small>
          <strong>{count.format(s.abandoned_checkouts)}</strong>
        </div>
        <div data-tip="Restaurant orders voided in the period.">
          <small>Voided orders</small>
          <strong>{count.format(s.voided_orders)}</strong>
        </div>
        <div data-tip="Discounts given on paid restaurant orders.">
          <small>Restaurant discounts</small>
          <strong>{money(s.discounts_kobo)}</strong>
        </div>
      </section>

      <section className="report-grid">
        <Panel
          className="report-wide"
          title="Revenue"
          tip="Settled money by when it was received: room payments and paid restaurant orders. Hover over or tab to a period for its figures."
          subtitle={`${money(s.total_revenue_kobo)} ${GRANULARITY_LABELS[data.range.granularity]}`}
          actions={
            <div className="period-control" role="group" aria-label="View">
              <button className={view === "chart" ? "active" : ""} aria-pressed={view === "chart"} onClick={() => setView("chart")}>
                Chart
              </button>
              <button className={view === "table" ? "active" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}>
                Table
              </button>
            </div>
          }
        >
          {view === "chart" ? (
            <>
              <Legend series={[ROOMS, RESTAURANT]} />
              <ColumnChart data={chartData.revenue} series={[ROOMS, RESTAURANT]} format={naira} axisFormat={compactMoney} label={`Revenue ${GRANULARITY_LABELS[data.range.granularity]}, rooms and restaurant`} />
            </>
          ) : (
            <SeriesTable report={data} />
          )}
        </Panel>

        <Panel title="Occupancy" tip="Share of available room-nights that were sold, per period. Measured per night." subtitle={hourly ? "Measured per night" : `${percent(s.occupancy, 1)} across the period`}>
          {hourly ? (
            <div className="report-hero">
              <strong>{percent(s.occupancy, 1)}</strong>
              <span>
                {s.nights_sold} of {s.available_nights} rooms occupied tonight. Choose a longer period to see the trend.
              </span>
            </div>
          ) : (
            <LineChart data={chartData.occupancy} series={OCCUPANCY} format={(value) => percent(value, 1)} axisFormat={(value) => percent(value)} max={1} label={`Occupancy ${GRANULARITY_LABELS[data.range.granularity]}`} />
          )}
        </Panel>

        <Panel title="Bookings made" tip="Reservations created per period, by when they were made (not when the guest arrives)." subtitle={`${count.format(s.bookings)} bookings ${GRANULARITY_LABELS[data.range.granularity]}`}>
          <ColumnChart data={chartData.bookings} series={[BOOKINGS]} format={(value) => count.format(value)} label={`Bookings made ${GRANULARITY_LABELS[data.range.granularity]}`} />
        </Panel>

        <Panel title="Occupancy by weekday" tip="Average occupancy for each night of the week across the period. Useful for pricing weekends and weekdays." subtitle="Which nights sell best">
          <ColumnChart data={chartData.weekdays} series={[OCCUPANCY]} format={(value) => percent(value, 1)} axisFormat={(value) => percent(value)} label="Average occupancy by night of the week" />
        </Panel>

        <Panel title="Revenue by payment method" tip="Settled room and restaurant money in the period, by how guests paid." subtitle={`${money(totalPayments)} settled`}>
          <BarList
            color={ROOMS.color}
            empty="No settled payments in this period."
            rows={data.breakdowns.payment_methods.map((row) => {
              const value = Number(row.room_kobo) + Number(row.restaurant_kobo);
              return {
                label: optionLabel(reference.paymentMethods, row.method),
                value,
                display: `${money(value)} · ${totalPayments ? percent(value / totalPayments) : "0%"}`,
                note: `Rooms ${money(row.room_kobo)} · Restaurant ${money(row.restaurant_kobo)} · ${row.count} payment${row.count === 1 ? "" : "s"}`,
              };
            })}
          />
        </Panel>

        <Panel title="Booking channels" tip="Where the bookings made in this period came from, and their value." subtitle={`${count.format(s.bookings)} bookings`}>
          <BarList
            color={ROOMS.color}
            empty="No bookings made in this period."
            rows={data.breakdowns.booking_sources.map((row) => ({
              label: SOURCE_LABELS[row.source] ?? humanize(row.source),
              value: row.bookings,
              display: `${row.bookings} · ${money(row.value_kobo)}`,
            }))}
          />
        </Panel>

        <Panel title="Booking outcomes" tip="Where the reservations made in this period stand now, including online checkouts that expired unpaid." subtitle={`${count.format(allBookings)} reservations`}>
          <BarList
            color={ROOMS.color}
            empty="No reservations made in this period."
            rows={data.breakdowns.booking_statuses.map((row) => ({
              label: optionLabel(reference.reservationStatuses, row.status),
              value: row.bookings,
              display: `${row.bookings} · ${allBookings ? percent(row.bookings / allBookings) : "0%"}`,
            }))}
          />
        </Panel>

        <Panel title="Top restaurant items" tip="Best-selling menu items by sales value on paid restaurant orders, before order discounts." subtitle={`${count.format(s.restaurant_orders)} paid orders`}>
          <BarList
            color={RESTAURANT.color}
            empty="No restaurant sales in this period."
            rows={data.breakdowns.top_items.map((row) => ({ label: row.name, value: Number(row.revenue_kobo), display: `${money(row.revenue_kobo)} · ${row.quantity} sold` }))}
          />
        </Panel>

        <Panel title="Room type performance" tip="Room-nights, occupancy, average daily rate and earned stay revenue by room category. Rooms counts rooms in service today." subtitle={`${data.rooms_in_service} rooms in service`}>
          {data.breakdowns.room_types.length === 0 ? (
            <Empty text="No rooms in service yet." />
          ) : (
            <div className="table-scroll">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Room type</th>
                    <th>Rooms</th>
                    <th>Room-nights</th>
                    <th>Occupancy</th>
                    <th>ADR</th>
                    <th>Stay revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdowns.room_types.map((row) => (
                    <tr key={row.room_type}>
                      <td>
                        <strong>{row.room_type}</strong>
                      </td>
                      <td>{row.rooms}</td>
                      <td>{count.format(row.nights)}</td>
                      <td>
                        <div className="report-meter" data-tip={percent(row.occupancy, 1)}>
                          <i style={{ width: `${Math.min(row.occupancy, 1) * 100}%` }} />
                        </div>
                        {percent(row.occupancy, 1)}
                      </td>
                      <td>{money(row.adr_kobo)}</td>
                      <td>{money(row.revenue_kobo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </section>
      <p className="report-note">
        Figures use {property.timezone} business days and committed records only. Occupancy is measured against the {data.rooms_in_service} rooms in service today. Updated {new Date(data.generatedAt).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit", timeZone: property.timezone })}.
      </p>
    </div>
  );
}
