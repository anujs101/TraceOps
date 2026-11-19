/** Read-only helpers over stored evidence rows. Nothing here computes a new quantity. */
import type { Evidence } from '../api.ts';

export type Point = [string, number];

export const TOOL_LABEL: Record<string, string> = {
  query_metric: 'Metric query',
  search_logs: 'Log search',
  log_patterns: 'Log patterns',
  log_volume: 'Log volume',
};

const args = (e: Evidence) => (e.args ?? {}) as Record<string, unknown>;

export function metricOf(e: Evidence | undefined): string | null {
  const m = e && args(e).metric;
  return e?.tool === 'query_metric' && typeof m === 'string' ? m : null;
}

/** What the row looked at: the metric name, or a plain name for the log tool. */
export function evidenceLabel(e: Evidence | undefined): string {
  if (!e) return 'missing evidence';
  const m = metricOf(e);
  if (m) return m;
  const sev = args(e).severity;
  const sevText = typeof sev === 'string' ? `${sev} ` : '';
  if (e.tool === 'log_patterns') return `${sevText}log patterns`;
  if (e.tool === 'search_logs') return `${sevText}log search`;
  if (e.tool === 'log_volume') return 'log volume';
  return TOOL_LABEL[e.tool] ?? e.tool;
}

export function seriesOf(e: Evidence | undefined): Point[] | null {
  if (!e || e.tool !== 'query_metric') return null;
  const s = (e.result as { series?: unknown } | null)?.series;
  if (!Array.isArray(s)) return null;
  const pts = s.filter((p): p is Point => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'number');
  return pts.length ? pts : null;
}

/** Unit of a cited field. Metric stats carry the metric's unit; log fields are counts. */
export function unitFor(e: Evidence | undefined, field?: string): string | null {
  if (!e) return null;
  if (e.tool !== 'query_metric') return field?.endsWith('.duration_ms') ? 'ms' : field?.endsWith('.status') ? null : 'count';
  if (field === 'points') return 'count';
  const u = (e.result as { unit?: unknown } | null)?.unit;
  return typeof u === 'string' && u ? u : null;
}

/** Index of the series point a cited field refers to, if it names one. */
export function markIndex(e: Evidence | undefined, field: string | undefined, pts: Point[]): number {
  if (!field || !e) return -1;
  const at = /^series@(.+)$/.exec(field)?.[1];
  if (at) return pts.findIndex((p) => p[0] === at);
  const vals = pts.map((p) => p[1]);
  if (field === 'first') return 0;
  if (field === 'last') return pts.length - 1;
  if (field === 'max') {
    const maxAt = (e.result as { max_at?: unknown } | null)?.max_at;
    const i = typeof maxAt === 'string' ? pts.findIndex((p) => p[0] === maxAt) : -1;
    return i >= 0 ? i : vals.indexOf(Math.max(...vals));
  }
  if (field === 'min') return vals.indexOf(Math.min(...vals));
  return -1;
}

/**
 * Stored average of the same metric over an earlier window (the baseline), if
 * the investigation queried one. Returns the stored stats.avg, never a new number.
 */
export function baselineFor(e: Evidence | undefined, all: Evidence[]): { avg: number; evidence: Evidence } | null {
  const m = metricOf(e);
  if (!e || !m || !e.window) return null;
  for (const o of all) {
    if (o.id === e.id || metricOf(o) !== m || o.status !== 'ok' || !o.window) continue;
    if (Date.parse(o.window.end) > Date.parse(e.window.start)) continue;
    const avg = o.stats?.avg;
    if (typeof avg === 'number') return { avg, evidence: o };
  }
  return null;
}

/** The headline stat of a row, for the ledger: max for metrics, sums/counts for logs. */
export function headline(e: Evidence): { field: string; value: number } | null {
  const s = e.stats ?? {};
  for (const k of ['max', 'error.sum', 'total.sum', 'p1.count', 'lines_returned', 'sampled_lines']) {
    const v = s[k];
    if (typeof v === 'number') return { field: k, value: v };
  }
  const first = Object.entries(s).find(([, v]) => typeof v === 'number');
  return first ? { field: first[0], value: first[1] as number } : null;
}
