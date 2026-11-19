/**
 * Hand-rolled SVG time-series chart over a STORED series (nothing resampled or
 * smoothed). Points before `splitAt` (incident start) are the lead-in, muted;
 * the incident part is the accent line over a shaded band with a soft area.
 * `baseline` is a stored average from an earlier window (dashed). `mark` rings
 * the point a report value cites. Axes show formatted min/max and times; hover
 * shows a crosshair with the point's time and formatted value.
 */
import { useEffect, useId, useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { Point } from '../lib/evidence.ts';
import { clock, formatValue, formatWithUnit } from '../lib/format.ts';

type Size = 'micro' | 'mini' | 'panel' | 'drawer';
type Props = {
  points: Point[];
  unit?: string | null;
  splitAt?: string | null;
  baseline?: number | null;
  mark?: number;
  size?: Size;
  label?: string;
};

const H: Record<Size, number> = { micro: 24, mini: 36, panel: 148, drawer: 220 };
const FIXED_W: Partial<Record<Size, number>> = { micro: 88, mini: 132 };
const AXES: Record<Size, boolean> = { micro: false, mini: false, panel: true, drawer: true };

function useWidth(fixed?: number): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fixed ?? 520);
  useEffect(() => {
    if (fixed || !ref.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { const cw = es[0]?.contentRect.width; if (cw && cw > 0) setW(Math.round(cw)); });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [fixed]);
  return [ref, w];
}

/** y-domain: data range (incl. baseline) with headroom; anchored at 0 when close to it. */
function domain(vals: number[]): [number, number] {
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { if (lo > 0) return [0, lo * 1.25]; const d = Math.abs(lo) || 1; lo -= d * 0.5; hi += d * 0.5; }
  const pad = (hi - lo) * 0.12;
  lo = lo >= 0 && lo - pad * 3 <= 0 ? 0 : lo - pad;
  return [lo, hi + pad];
}

export function Chart({ points, unit, splitAt, baseline, mark = -1, size = 'panel', label }: Props) {
  const fixed = FIXED_W[size];
  const [ref, W] = useWidth(fixed);
  const gid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const axes = AXES[size];
  const h = H[size];
  const ts = points.map((p) => Date.parse(p[0]));
  const vals = points.map((p) => p[1]);
  const hasBase = baseline != null && Number.isFinite(baseline);
  const [lo, hi] = domain(hasBase ? [...vals, baseline!] : vals);
  // axis labels: compact (no count words), so the gutter stays narrow
  const fmtAxis = (v: number) => {
    const f = formatValue(v, unit);
    return f.unit === '%' ? `${f.text}%` : f.unit === 's' || f.unit === 'ms' ? `${f.text} ${f.unit}` : f.text;
  };
  const ticksY = axes ? [hi, (hi + lo) / 2, lo] : [];
  const gutter = axes ? Math.max(28, Math.max(...ticksY.map((v) => fmtAxis(v).length)) * 6.4 + 10) : 2;
  const P = axes ? { l: gutter, r: 10, t: 10, b: 24 } : { l: 2, r: 2, t: 3, b: 3 };
  const t0 = ts[0]!, t1 = ts.at(-1)!;
  const span = t1 - t0 || 1;
  const iw = Math.max(10, W - P.l - P.r), ih = h - P.t - P.b;
  const x = (t: number) => (points.length === 1 ? P.l + iw / 2 : P.l + ((t - t0) / span) * iw);
  const y = (v: number) => P.t + ih - ((v - lo) / (hi - lo)) * ih;
  const line = (idx: number[]) => idx.map((i, n) => `${n ? 'L' : 'M'}${x(ts[i]!).toFixed(1)},${y(vals[i]!).toFixed(1)}`).join(' ');

  const split = splitAt ? Date.parse(splitAt) : NaN;
  const all = points.map((_, i) => i);
  const firstInc = Number.isNaN(split) ? 0 : ts.findIndex((t) => t >= split);
  const leadOnly = firstInc === -1;
  const lead = leadOnly ? all : firstInc > 0 ? all.slice(0, firstInc + 1) : [];
  const inc = leadOnly ? [] : all.slice(Math.max(0, firstInc));
  const shadeX = leadOnly ? null : !Number.isNaN(split) && split > t0 && split <= t1 ? x(split) : P.l;
  const area = inc.length > 1 ? `${line(inc)} L${x(ts[inc.at(-1)!]!).toFixed(1)},${(P.t + ih).toFixed(1)} L${x(ts[inc[0]!]!).toFixed(1)},${(P.t + ih).toFixed(1)} Z` : null;

  const fmt = (v: number) => formatWithUnit(v, unit, true);
  const aria = label ?? `${points.length} points from ${clock(points[0]![0])} to ${clock(points.at(-1)![0])}, low ${fmt(Math.min(...vals))}, high ${fmt(Math.max(...vals))}`;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!axes) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(ts[i]!) - px) < Math.abs(x(ts[best]!) - px)) best = i;
    setHover(best);
  };

  // x ticks: start, incident start (only when it has room), end
  const splitRoom = shadeX !== null && split > t0 && split < t1 && x(split) - x(t0) > 70 && x(t1) - x(split) > 70;
  const ticksX = axes ? [t0, ...(splitRoom ? [split] : []), t1] : [];

  return (
    <div ref={ref} className={`chart chart-${size}`} style={fixed ? { width: fixed } : undefined}>
      <svg viewBox={`0 0 ${W} ${h}`} width={fixed ? W : undefined} height={fixed ? h : undefined} role="img" aria-label={aria}
        onPointerMove={axes ? onMove : undefined} onPointerLeave={axes ? () => setHover(null) : undefined}>
        <defs>
          <linearGradient id={`g${gid}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" className="area-top" />
            <stop offset="100%" className="area-bottom" />
          </linearGradient>
        </defs>
        {axes && ticksY.map((v, i) => (
          <g key={i}>
            <line className="grid" x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} />
            <text className="axis" x={P.l - 8} y={y(v)} dy="0.32em" textAnchor="end">{fmtAxis(v)}</text>
          </g>
        ))}
        {shadeX !== null && <rect className="shade" x={shadeX} y={P.t} width={Math.max(0, W - P.r - shadeX)} height={ih} />}
        {axes && shadeX !== null && split > t0 && split < t1 && <line className="split" x1={shadeX} x2={shadeX} y1={P.t} y2={P.t + ih} />}
        {hasBase && <line className="base" x1={P.l} x2={W - P.r} y1={y(baseline!)} y2={y(baseline!)} />}
        {area && <path className="area" d={area} fill={`url(#g${gid})`} />}
        {points.length === 1 ? <circle className="dot" cx={x(ts[0]!)} cy={y(vals[0]!)} r={3} /> : (
          <>
            {lead.length > 1 && <path className="lead" d={line(lead)} />}
            {inc.length > 1 && <path className="inc" d={line(inc)} />}
            {inc.length === 1 && <circle className="dot" cx={x(ts[inc[0]!]!)} cy={y(vals[inc[0]!]!)} r={2.5} />}
          </>
        )}
        {mark >= 0 && mark < points.length && <circle className="mark" cx={x(ts[mark]!)} cy={y(vals[mark]!)} r={size === 'micro' || size === 'mini' ? 2.75 : 4.5} />}
        {axes && ticksX.map((t, i) => (
          <text key={i} className={`axis${t === split ? ' axis-split' : ''}`} x={x(t)} y={h - 6}
            textAnchor={i === 0 ? 'start' : i === ticksX.length - 1 ? 'end' : 'middle'}>{clock(new Date(t).toISOString())}</text>
        ))}
        {hover !== null && (
          <g className="hover" aria-hidden="true">
            <line x1={x(ts[hover]!)} x2={x(ts[hover]!)} y1={P.t} y2={P.t + ih} />
            <circle cx={x(ts[hover]!)} cy={y(vals[hover]!)} r={4} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" aria-hidden="true" style={{ left: Math.min(Math.max(x(ts[hover]!), 70), W - 70), top: Math.max(0, y(vals[hover]!) - 44) }}>
          <span className="chart-tip-v">{fmt(vals[hover]!)}</span>
          <span className="chart-tip-t">{clock(points[hover]![0])} UTC</span>
        </div>
      )}
    </div>
  );
}
