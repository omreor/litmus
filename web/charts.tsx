import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Poll } from "./hooks";

export type Point = { x: number; y: number };
export type Series = { name: string; color: string; points: Point[] };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  return Array.from({ length: Math.ceil(max / step - 1e-9) + 1 }, (_, i) => i * step);
}

// Linear interpolation of y at x along a series sorted by x; null outside its range.
function yAt(points: Point[], x: number) {
  if (!points.length || x < points[0].x || x > points.at(-1)!.x) return null;
  const i = points.findIndex((p) => p.x >= x);
  if (i <= 0) return points[0].y;
  const [a, b] = [points[i - 1], points[i]];
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x || 1);
}

export function LineChart(props: {
  series: Series[];
  height?: number;
  xFormat: (v: number) => string;
  yFormat: (v: number) => string;
  xLabel: string;
}) {
  const { series, height = 240, xFormat, yFormat, xLabel } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hoverX, setHoverX] = useState<number | null>(null);
  const pad = { l: 64, r: 20, t: 12, b: 40 };
  const all = series.flatMap((s) => s.points);
  const xTicks = niceTicks(Math.max(...all.map((p) => p.x), 0));
  const yTicks = niceTicks(Math.max(...all.map((p) => p.y), 0));
  const [xMax, yMax] = [xTicks.at(-1)!, yTicks.at(-1)!];
  const plotW = Math.max(width - pad.l - pad.r, 10);
  const plotH = height - pad.t - pad.b;
  const sx = (x: number) => pad.l + (x / xMax) * plotW;
  const sy = (y: number) => pad.t + plotH - (y / yMax) * plotH;
  const path = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHoverX(Math.min(Math.max(((e.clientX - box.left) / box.width) * xMax, 0), xMax));
  };
  const readout = hoverX === null ? [] : series.map((s) => ({ s, y: yAt(s.points, hoverX) })).filter((r) => r.y !== null);

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${series.map((s) => s.name).join(", ")} by ${xLabel}`}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke={t ? "var(--grid)" : "var(--axis)"} />
              <text x={pad.l - 8} y={sy(t) + 4} textAnchor="end">{yFormat(t)}</text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={height - pad.b + 16} textAnchor="middle">{xFormat(t)}</text>
          ))}
          <text x={pad.l + plotW / 2} y={height - 4} textAnchor="middle">{xLabel}</text>
          {series.length === 1 && (
            <path
              d={`${path(series[0].points)}L${sx(series[0].points.at(-1)!.x)},${sy(0)}L${sx(series[0].points[0].x)},${sy(0)}Z`}
              fill={series[0].color} opacity={0.1}
            />
          )}
          {series.map((s) => (
            <path key={s.name} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const end = s.points.at(-1)!;
            return <circle key={s.name} cx={sx(end.x)} cy={sy(end.y)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />;
          })}
          {hoverX !== null && (
            <>
              <line x1={sx(hoverX)} x2={sx(hoverX)} y1={pad.t} y2={pad.t + plotH} stroke="var(--axis)" />
              {readout.map(({ s, y }) => (
                <circle key={s.name} cx={sx(hoverX)} cy={sy(y!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </>
          )}
          <rect
            x={pad.l} y={pad.t} width={plotW} height={plotH} fill="transparent"
            onPointerMove={onMove} onPointerLeave={() => setHoverX(null)}
          />
        </svg>
      )}
      {hoverX !== null && readout.length > 0 && (
        <div className="tooltip" style={{ left: Math.min(sx(hoverX) + 12, width - 180), top: pad.t }}>
          <div className="head">{xFormat(hoverX)} {xLabel}</div>
          {readout.map(({ s, y }) => (
            <div className="row" key={s.name}>
              <span className="key" style={{ background: s.color }} />
              <b>{yFormat(y!)}</b>
              <span className="muted">{s.name}</span>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span className="item" key={s.name}>
              <span className="line" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export type Column = { label: string; title?: string; values: number[]; detail?: string };

// Rounded 4px data-end, square at the baseline.
const columnPath = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;

// Few single-series columns carry their value on the cap. Denser or multi-series charts get a y-axis
// instead, and their values live in the tooltip and the table view.
export function ColumnChart(props: {
  columns: Column[];
  series: { name: string; color: string }[];
  format: (v: number) => string;
  tickFormat?: (v: number) => string;
  stacked?: boolean;
  max?: number;
  height?: number;
  highlight?: { index: number; label: string };
}) {
  const { columns, series, format, tickFormat = format, stacked = false, max, height = 200, highlight } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const axis = series.length > 1 || columns.length > 8;
  const totals = columns.map((c) => (stacked ? c.values.reduce((s, v) => s + v, 0) : Math.max(...c.values)));
  const ticks = niceTicks(max ?? Math.max(...totals, 0));
  const top = max ?? ticks.at(-1)!;
  const pad = { l: axis ? 8 + Math.max(...ticks.map((t) => tickFormat(t).length)) * 7 : 8, r: 8, t: 20, b: 24 };
  const plotW = Math.max(width - pad.l - pad.r, 10);
  const plotH = height - pad.t - pad.b;
  const sy = (v: number) => pad.t + plotH - (v / top) * plotH;
  const band = plotW / columns.length;
  const bars = stacked ? 1 : series.length;
  const barW = Math.max(Math.min(24, (band * 0.7 - (bars - 1) * 2) / bars), 2);
  const groupW = bars * barW + (bars - 1) * 2;
  const center = (i: number) => pad.l + band * i + band / 2;
  // Show every nth x label so labels never collide (~6px per character at 11px).
  const every = Math.ceil((columns.length * (Math.max(...columns.map((c) => c.label.length)) * 6 + 6)) / plotW);
  const dimmed = (i: number) => (hover !== null ? hover !== i : highlight !== undefined && highlight.index !== i);
  const describe = (c: Column) =>
    `${c.title ?? c.label}: ${series.map((s, j) => `${series.length > 1 ? `${s.name} ` : ""}${format(c.values[j])}`).join(", ")}`;

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={columns.map(describe).join("; ")}>
          {axis
            ? ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={width - pad.r} y1={sy(t)} y2={sy(t)} stroke={t ? "var(--grid)" : "var(--axis)"} />
                  <text x={pad.l - 8} y={sy(t) + 4} textAnchor="end">{tickFormat(t)}</text>
                </g>
              ))
            : <line x1={pad.l} x2={width - pad.r} y1={sy(0)} y2={sy(0)} stroke="var(--axis)" />}
          {columns.map((c, i) => {
            const x0 = center(i) - groupW / 2;
            const topSegment = c.values.findLastIndex((v) => v > 0);
            let base = 0;
            return (
              <g key={c.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect x={pad.l + band * i} y={pad.t} width={band} height={plotH + pad.b} fill="transparent" />
                <g opacity={dimmed(i) ? 0.45 : 1}>
                  {c.values.map((v, s) => {
                    const from = stacked ? base : 0;
                    base += v;
                    const x = stacked ? x0 : x0 + s * (barW + 2);
                    const y = sy(from + v);
                    // Stacked segments sit 2px above the one below (surface gap).
                    const h = sy(from) - y - (from > 0 ? 2 : 0);
                    if (h <= 0) return null;
                    const r = !stacked || s === topSegment ? Math.min(4, h, barW / 2) : 0;
                    return <path key={series[s].name} d={columnPath(x, y, barW, h, r)} fill={series[s].color} />;
                  })}
                </g>
                {!axis && <text x={center(i)} y={sy(totals[i]) - 6} textAnchor="middle" className="value">{format(totals[i])}</text>}
                {highlight?.index === i && <text x={center(i)} y={sy(totals[i]) - 6} textAnchor="middle" className="hl">{highlight.label}</text>}
                {i % every === 0 && (
                  <text x={center(i)} y={height - 6} textAnchor="middle" className={highlight?.index === i ? "hl" : undefined}>{c.label}</text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && (
        <div className="tooltip" style={{ left: center(hover), top: 0, transform: `translateX(-${(center(hover) / width) * 100}%)` }}>
          <div className="head">{columns[hover].title ?? columns[hover].label}</div>
          {series.map((s, j) => (
            <div className="row" key={s.name}>
              <span className="key" style={{ background: s.color }} />
              <b>{format(columns[hover].values[j])}</b>
              {series.length > 1 && <span className="muted">{s.name}</span>}
            </div>
          ))}
          {columns[hover].detail && <div className="muted">{columns[hover].detail}</div>}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span className="item" key={s.name}>
              <span className="rect" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function TableView({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="table-view">
      <summary>Show as table</summary>
      <div className="table-scroll">
        <table>
          <thead><tr>{head.map((h, i) => <th key={h} className={i ? "num" : undefined}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]}>{row.map((v, i) => <td key={i} className={i ? "num" : undefined}>{v}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// Loading, error and empty states for a polled chart or table; renders nothing once there is data.
export function Placeholder({ poll, empty, height }: { poll: Poll<unknown>; empty: string; height?: number }) {
  const { data, error } = poll;
  if (data && !(Array.isArray(data) && data.length === 0)) return null;
  return (
    <div className="empty" role="status" style={{ minHeight: height }}>
      {data ? empty : error ? `Couldn't load this (${error}). Retrying…` : "Loading…"}
    </div>
  );
}

export function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export function Meter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(value, 1));
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <div className="track"><div className="fill" style={{ width: `${v * 100}%` }} /></div>
      <span>{(v * 100).toFixed(0)}%</span>
    </div>
  );
}

export function StackBar({ parts }: { parts: { label: string; value: number; color: string; note?: ReactNode }[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const visible = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div className="stack" role="img" aria-label={visible.map((p) => `${p.label} ${((p.value / total) * 100).toFixed(1)}%`).join(", ")}>
        {visible.map((p) => (
          <div key={p.label} title={`${p.label}: ${((p.value / total) * 100).toFixed(1)}%`} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="legend">
        {visible.map((p) => (
          <span className="item" key={p.label}>
            <span className="rect" style={{ background: p.color }} />
            {p.label} <b>{((p.value / total) * 100).toFixed(1)}%</b>
            {p.note}
          </span>
        ))}
      </div>
    </div>
  );
}
