import { useEffect, useRef, useState, type ReactNode } from "react";

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

export function ColumnChart(props: {
  bars: { label: string; value: number; detail: string; color?: string }[];
  height?: number;
  format: (v: number) => string;
  color?: string;
  max?: number;
}) {
  const { bars, height = 180, format, color = "var(--s1)", max } = props;
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 8, r: 8, t: 20, b: 24 };
  const plotH = height - pad.t - pad.b;
  const top = max ?? Math.max(...bars.map((b) => b.value), 1e-9);
  const band = (width - pad.l - pad.r) / bars.length;
  const barW = Math.min(24, band * 0.6);
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={bars.map((b) => `${b.label}: ${format(b.value)}`).join("; ")}>
          <line x1={pad.l} x2={width - pad.r} y1={pad.t + plotH} y2={pad.t + plotH} stroke="var(--axis)" />
          {bars.map((b, i) => {
            const h = (b.value / top) * plotH;
            const x = pad.l + band * i + (band - barW) / 2;
            const y = pad.t + plotH - h;
            const r = Math.min(4, h / 2, barW / 2);
            return (
              <g key={b.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect x={pad.l + band * i} y={pad.t} width={band} height={plotH + pad.b} fill="transparent" />
                {h > 0 && (
                  <path
                    d={`M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${y + h}Z`}
                    fill={b.color ?? color} opacity={hover === null || hover === i ? 1 : 0.6}
                  />
                )}
                <text x={x + barW / 2} y={y - 6} textAnchor="middle" style={{ fill: "var(--text-2)" }}>{format(b.value)}</text>
                <text x={x + barW / 2} y={height - 6} textAnchor="middle">{b.label}</text>
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && (
        <div className="tooltip" style={{ left: Math.min(pad.l + band * hover + band / 2, width - 200), top: 0 }}>
          <div className="row"><b>{format(bars[hover].value)}</b><span className="muted">{bars[hover].label}</span></div>
          <div className="muted">{bars[hover].detail}</div>
        </div>
      )}
    </div>
  );
}

export function Meter({ value, near = 0.9 }: { value: number; near?: number }) {
  const v = Math.max(0, Math.min(value, 1));
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <div className="track"><div className={v >= near ? "fill near" : "fill"} style={{ width: `${v * 100}%` }} /></div>
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
