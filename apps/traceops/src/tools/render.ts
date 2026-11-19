import { renderPromql, type InvestigationWindows, type MetricName } from '@traceops/contracts';

/**
 * The only place queries are built. Model input never reaches a query except as an
 * escaped string literal (search_logs `contains`) or a template name (metric).
 */

export const SERVICE_RE = /^[a-z0-9-]+$/;

function assertService(service: string): void {
  if (!SERVICE_RE.test(service)) throw new Error('invalid service name');
}

// ── windows ─────────────────────────────────────────────────────────────────

export type Window = { start: string; end: string };
export type WindowArg = Window | 'incident' | 'baseline';
export type WindowResult = { ok: true; window: Window } | { ok: false; reason: string };

/**
 * Resolve a checked window argument (explicit windows are already UTC-ms normalised
 * by `*Checked`) and require it to lie inside `allowed` (tools.md §1, detection.md §6).
 */
export function resolveWindow(arg: WindowArg, windows: InvestigationWindows): WindowResult {
  if (arg === 'incident') return { ok: true, window: { ...windows.incident } };
  if (arg === 'baseline') return { ok: true, window: { ...windows.baseline } };
  const { allowed } = windows;
  if (Date.parse(arg.start) < Date.parse(allowed.start) || Date.parse(arg.end) > Date.parse(allowed.end)) {
    return { ok: false, reason: `window must lie within ${allowed.start} and ${allowed.end}` };
  }
  return { ok: true, window: { start: arg.start, end: arg.end } };
}

/** Smallest multiple of `baseS` that keeps a window under the 60-point series cap. */
export function stepFor(window: Window, baseS: number, maxPoints = 60): number {
  const spanS = (Date.parse(window.end) - Date.parse(window.start)) / 1000;
  return Math.max(1, Math.ceil(spanS / ((maxPoints - 1) * baseS))) * baseS;
}

export const METRIC_STEP_S = 15;
export const VOLUME_STEP_S = 60;

// ── PromQL ──────────────────────────────────────────────────────────────────

export function renderMetricQuery(metric: MetricName, service: string): string {
  assertService(service);
  return renderPromql(metric, service);
}

// ── LogQL ───────────────────────────────────────────────────────────────────

/** A LogQL double-quoted string literal. JSON escaping is a subset LogQL accepts. */
export function logqlString(s: string): string {
  return JSON.stringify(s);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
}

export type LogFilter = {
  severity: 'error' | 'warn' | 'info' | null;
  match: { field: 'message' | 'exception_message'; contains: string } | null;
};

/** tools.md §4: `{service_name="$svc"}` + severity + message / exception_message filter. */
export function renderLogQuery(service: string, f: LogFilter = { severity: null, match: null }): string {
  assertService(service);
  let q = `{service_name="${service}"}`;
  if (f.severity) q += ` | severity_text=${logqlString(f.severity)}`;
  if (f.match?.field === 'message') q += ` |= ${logqlString(f.match.contains)}`;
  else if (f.match?.field === 'exception_message') q += ` | exception_message=~${logqlString(`(?i).*${escapeRegex(f.match.contains)}.*`)}`;
  return q;
}

/** tools.md §6. */
export function renderVolumeQuery(service: string): string {
  assertService(service);
  return `sum by (severity_text) (count_over_time({service_name="${service}"}[1m]))`;
}
