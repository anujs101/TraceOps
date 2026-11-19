/**
 * Hand-rolled SVG sparkline over a stored series. Points before `splitAt`
 * (the incident start) are the lead-in, drawn muted; points from it on are the
 * incident, drawn strong over a shaded band. `baseline` is a stored average
 * from an earlier window, drawn dashed. Nothing is resampled or smoothed.
 */
import type { Point } from '../lib/evidence.ts';
import { clock, formatWithUnit } from '../lib/format.ts';

type Props = {
  points: Point[];
  unit?: string | null;
  splitAt?: string | null;
  baseline?: number | null;
  mark?: number;
  size?: 'micro' | 'small' | 'large';
  label?: string;
};

const SIZES = { micro: [72, 20, 2], small: [120, 28, 3], large: [400, 120, 8] } as const;

export function Sparkline({ points, unit, splitAt, baseline, mark = -1, size = 'small', label }: Props) {
  const [W, H, P] = SIZES[size];
  const ts = points.map((p) => Date.parse(p[0]));
  const vals = points.map((p) => p[1]);
  const domain = baseline != null && Number.isFinite(baseline) ? [...vals, baseline] : vals;
  let min = Math.min(...domain), max = Math.max(...domain);
  if (min === max) { min -= 1; max += 1; }
  const t0 = ts[0]!, t1 = ts.at(-1)!;
  const span = t1 - t0 || 1;
  const x = (t: number) => (points.length === 1 ? W / 2 : P + ((t - t0) / span) * (W - 2 * P));
  const y = (v: number) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  const path = (idx: number[]) => idx.map((i, n) => `${n ? 'L' : 'M'}${x(ts[i]!).toFixed(1)},${y(vals[i]!).toFixed(1)}`).join(' ');

  const split = splitAt ? Date.parse(splitAt) : NaN;
  const all = points.map((_, i) => i);
  // lead-in includes the first incident point so the line stays continuous
  const firstInc = Number.isNaN(split) ? 0 : ts.findIndex((t) => t >= split);
  const lead = firstInc > 0 ? all.slice(0, firstInc + 1) : [];
  const inc = firstInc === -1 ? [] : all.slice(Math.max(0, firstInc));
  const leadOnly = firstInc === -1; // whole series is before the incident start
  const shadeX = !Number.isNaN(split) && split > t0 && split <= t1 ? x(split) : firstInc === 0 ? P : null;

  const aria = label ?? `${points.length} points from ${clock(points[0]![0])} to ${clock(points.at(-1)![0])}, low ${formatWithUnit(Math.min(...vals), unit, true)}, high ${formatWithUnit(Math.max(...vals), unit, true)}`;

  return (
    <svg className={`spark spark-${size}`} viewBox={`0 0 ${W} ${H}`} width={size === 'large' ? undefined : W} height={size === 'large' ? undefined : H}
      role="img" aria-label={aria}>
      {shadeX !== null && !leadOnly && <rect className="spark-shade" x={shadeX} y={0} width={Math.max(0, W - shadeX)} height={H} />}
      {baseline != null && Number.isFinite(baseline) && (
        <line className="spark-base" x1={P} x2={W - P} y1={y(baseline)} y2={y(baseline)} vectorEffect="non-scaling-stroke" />
      )}
      {points.length === 1 ? <circle className="spark-dot" cx={x(ts[0]!)} cy={y(vals[0]!)} r={size === 'large' ? 3 : 2} /> : (
        <>
          {(leadOnly ? all : lead).length > 1 && <path className="spark-lead" d={path(leadOnly ? all : lead)} vectorEffect="non-scaling-stroke" />}
          {inc.length > 1 && <path className="spark-inc" d={path(inc)} vectorEffect="non-scaling-stroke" />}
          {inc.length === 1 && <circle className="spark-dot" cx={x(ts[inc[0]!]!)} cy={y(vals[inc[0]!]!)} r={2} />}
        </>
      )}
      {mark >= 0 && mark < points.length && (
        <circle className="spark-mark" cx={x(ts[mark]!)} cy={y(vals[mark]!)} r={size === 'large' ? 4.5 : 2.75} vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
