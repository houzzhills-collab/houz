"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Small SVG charts for the reports section. One y-axis per chart, thin marks,
 * recessive grid, and a tooltip on hover or keyboard focus of each period.
 * Values in tooltips are also available in the table views beside the charts.
 */

export type ChartSeries = { name: string; color: string };
/** One period on the x-axis: a short axis label, a full label for the tooltip, and one value per series. */
export type ChartDatum = { label: string; detail: string; values: Array<number | null> };

const HEIGHT = 220;
const MARGIN = { top: 14, right: 14, bottom: 26, left: 58 };
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;
const MIN_LABEL_SPACING = 62;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Round axis ticks from 0 up to at least `max`. */
function ticksFor(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1, 2, 3, 4];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const residual = raw / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10) * magnitude;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);
}

/** A column with a rounded data end and a square base. */
function columnPath(x: number, y: number, width: number, height: number, rounded: boolean): string {
  if (height <= 0) return "";
  const r = rounded ? Math.min(RADIUS, height, width / 2) : 0;
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

type Layout = { width: number; plotWidth: number; plotHeight: number; band: number; x: (index: number) => number; y: (value: number) => number; ticks: number[] };

function layout(width: number, count: number, ticks: number[]): Layout {
  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotWidth / Math.max(count, 1);
  const top = ticks.at(-1) ?? 1;
  return {
    width,
    plotWidth,
    plotHeight,
    band,
    ticks,
    x: (index) => MARGIN.left + band * index + band / 2,
    y: (value) => MARGIN.top + plotHeight - (Math.max(value, 0) / top) * plotHeight,
  };
}

function Axes({ frame, data, axisFormat }: { frame: Layout; data: ChartDatum[]; axisFormat: (value: number) => string }) {
  const step = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(frame.plotWidth / MIN_LABEL_SPACING))));
  return (
    <g className="viz-axes" aria-hidden>
      {frame.ticks.map((tick) => (
        <g key={tick}>
          <line x1={MARGIN.left} x2={MARGIN.left + frame.plotWidth} y1={frame.y(tick)} y2={frame.y(tick)} className={tick === 0 ? "viz-baseline" : "viz-grid"} />
          <text x={MARGIN.left - 8} y={frame.y(tick)} dy="0.32em" textAnchor="end">
            {axisFormat(tick)}
          </text>
        </g>
      ))}
      {data.map((datum, index) =>
        index % step === 0 ? (
          <text key={index} x={frame.x(index)} y={HEIGHT - 8} textAnchor="middle">
            {datum.label}
          </text>
        ) : null,
      )}
    </g>
  );
}

function Tooltip({ frame, index, datum, series, format }: { frame: Layout; index: number; datum: ChartDatum; series: ChartSeries[]; format: (value: number) => string }) {
  const center = frame.x(index);
  const flip = center > frame.width - 190;
  const total = series.length > 1 ? datum.values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  return (
    <div className="viz-tooltip" role="status" style={flip ? { right: frame.width - center + 12 } : { left: center + 12 }}>
      <small>{datum.detail}</small>
      {series.map((item, position) => (
        <div key={item.name} className="viz-tooltip-row">
          <i style={{ background: item.color }} />
          <strong>{datum.values[position] === null ? "—" : format(datum.values[position] ?? 0)}</strong>
          <span>{item.name}</span>
        </div>
      ))}
      {total !== null && (
        <div className="viz-tooltip-row viz-tooltip-total">
          <strong>{format(total)}</strong>
          <span>Total</span>
        </div>
      )}
    </div>
  );
}

/** Transparent, focusable hit targets the full height of each period's band. */
function HitBands({ frame, data, onActive }: { frame: Layout; data: ChartDatum[]; onActive: (index: number | null) => void }) {
  return (
    <g>
      {data.map((datum, index) => (
        <rect
          key={index}
          className="viz-hit"
          x={MARGIN.left + frame.band * index}
          y={MARGIN.top}
          width={frame.band}
          height={frame.plotHeight}
          tabIndex={0}
          aria-label={datum.detail}
          onPointerEnter={() => onActive(index)}
          onFocus={() => onActive(index)}
          onBlur={() => onActive(null)}
        />
      ))}
    </g>
  );
}

export function Legend({ series, kind = "bar" }: { series: ChartSeries[]; kind?: "bar" | "line" }) {
  return (
    <div className="viz-legend">
      {series.map((item) => (
        <span key={item.name}>
          <i className={kind === "line" ? "is-line" : ""} style={{ background: item.color }} />
          {item.name}
        </span>
      ))}
    </div>
  );
}

/** Columns over time; several series stack with a 2px gap between segments. */
export function ColumnChart({ data, series, format, axisFormat = format, label }: { data: ChartDatum[]; series: ChartSeries[]; format: (value: number) => string; axisFormat?: (value: number) => string; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const totals = data.map((datum) => datum.values.reduce<number>((sum, value) => sum + (value ?? 0), 0));
  const frame = layout(width, data.length, ticksFor(Math.max(0, ...totals)));
  const barWidth = Math.max(2, Math.min(BAR_MAX, frame.band - GAP * 2, frame.band * 0.72));

  return (
    <div className="viz" ref={ref} onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label}>
          <Axes frame={frame} data={data} axisFormat={axisFormat} />
          {active !== null && <rect className="viz-band" x={MARGIN.left + frame.band * active} y={MARGIN.top} width={frame.band} height={frame.plotHeight} />}
          {data.map((datum, index) => {
            const topSeries = datum.values.findLastIndex((value) => (value ?? 0) > 0);
            let base = frame.y(0);
            return (
              <g key={index}>
                {datum.values.map((value, position) => {
                  if (!value || value <= 0) return null;
                  // The segment keeps its true top; a 2px gap is taken from its base when it sits on another.
                  const full = frame.y(0) - frame.y(value);
                  const gap = base < frame.y(0) ? GAP : 0;
                  const top = base - full;
                  const path = columnPath(frame.x(index) - barWidth / 2, top, barWidth, Math.max(full - gap, 1), position === topSeries);
                  base = top;
                  return <path key={position} d={path} fill={series[position]?.color} />;
                })}
              </g>
            );
          })}
          <HitBands frame={frame} data={data} onActive={setActive} />
        </svg>
      )}
      {active !== null && data[active] && <Tooltip frame={frame} index={active} datum={data[active]} series={series} format={format} />}
    </div>
  );
}

/** A single series as a 2px line over a light wash, with a crosshair and an end label. Gaps (null) break the line. */
export function LineChart({ data, series, format, axisFormat = format, max, label }: { data: ChartDatum[]; series: ChartSeries; format: (value: number) => string; axisFormat?: (value: number) => string; max?: number; label: string }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const values = data.map((datum) => datum.values[0] ?? null);
  const frame = layout(width, data.length, max !== undefined ? ticksFor(max) : ticksFor(Math.max(0, ...values.map((value) => value ?? 0))));
  const points = values.map((value, index) => (value === null ? null : ([frame.x(index), frame.y(value)] as const)));
  const line = points.map((point, index) => (point ? `${index === 0 || !points[index - 1] ? "M" : "L"}${point[0]},${point[1]}` : "")).join("");
  const defined = points.filter((point) => point !== null);
  const area = defined.length > 1 ? `${line}L${defined.at(-1)![0]},${frame.y(0)}L${defined[0]![0]},${frame.y(0)}Z` : "";
  const lastIndex = values.findLastIndex((value) => value !== null);
  const focus = active ?? lastIndex;

  return (
    <div className="viz" ref={ref} onPointerLeave={() => setActive(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={label}>
          <Axes frame={frame} data={data} axisFormat={axisFormat} />
          {area && <path d={area} fill={series.color} opacity={0.1} />}
          <path d={line} fill="none" stroke={series.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {active !== null && <line className="viz-crosshair" x1={frame.x(active)} x2={frame.x(active)} y1={MARGIN.top} y2={MARGIN.top + frame.plotHeight} />}
          {focus >= 0 && points[focus] && <circle cx={points[focus][0]} cy={points[focus][1]} r={4} fill={series.color} stroke="#fff" strokeWidth={2} />}
          {active === null && lastIndex >= 0 && points[lastIndex] && (
            <text className="viz-end-label" x={points[lastIndex][0] - 8} y={points[lastIndex][1] - 10} textAnchor="end">
              {format(values[lastIndex] ?? 0)}
            </text>
          )}
          <HitBands frame={frame} data={data} onActive={setActive} />
        </svg>
      )}
      {active !== null && data[active] && <Tooltip frame={frame} index={active} datum={data[active]} series={[series]} format={format} />}
    </div>
  );
}

/** Ranked horizontal bars with the value beside each; for shares of a whole. */
export function BarList({ rows, color, empty }: { rows: Array<{ label: string; value: number; display: string; note?: string }>; color: string; empty: string }) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  if (rows.length === 0) return <div className="empty-state">{empty}</div>;
  return (
    <ul className="viz-barlist">
      {rows.map((row) => (
        <li key={row.label} data-tip={row.note}>
          <div className="viz-barlist-text">
            <span>{row.label}</span>
            <strong>{row.display}</strong>
          </div>
          <div className="viz-barlist-track">
            <i style={{ width: `${max > 0 ? Math.max((row.value / max) * 100, row.value > 0 ? 1.5 : 0) : 0}%`, background: color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
