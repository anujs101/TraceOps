import type { z } from 'zod';
import { LIMITS, toIsoUtcMs, type IsoUtcMs, type QueryMetricOutput } from '@traceops/contracts';

export type Point = z.infer<typeof QueryMetricOutput>['series'][number];
export type SeriesStats = NonNullable<z.infer<typeof QueryMetricOutput>['stats']>;

/** [unix s, "value"] → [IsoUtcMs, number]; NaN / ±Inf points are dropped (tools.md §2). */
export function parseSamples(values: [number, string][]): Point[] {
  const out: Point[] = [];
  for (const [t, v] of values) {
    const n = Number(v);
    if (Number.isFinite(n)) out.push([toIsoUtcMs(t, 's'), n]);
  }
  return out;
}

/** Defensive: the step chooser already keeps windows ≤ 60 points. Evenly thins, keeping the last point. */
export function capPoints(points: Point[], max: number = LIMITS.maxSeriesPoints): Point[] {
  if (points.length <= max) return points;
  const out: Point[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  return out;
}

export function seriesStats(points: Point[]): SeriesStats {
  const vals = points.map((p) => p[1]);
  const sum = vals.reduce((a, b) => a + b, 0);
  return { min: Math.min(...vals), max: Math.max(...vals), avg: sum / vals.length, first: vals[0]!, last: vals[vals.length - 1]!, points: vals.length };
}

export const seriesSum = (points: Point[]): number => points.reduce((a, p) => a + p[1], 0);

/** Timestamp of the first point holding the maximum. */
export function maxAt(points: Point[]): IsoUtcMs {
  let best = points[0]!;
  for (const p of points) if (p[1] > best[1]) best = p;
  return best[0];
}
