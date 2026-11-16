/**
 * Spike helper: turns the committed REAL S1 fixtures (raw Prometheus/Loki
 * responses) into tool outputs + Evidence rows, so live LLM checks run on real
 * telemetry without touching any backend. Not the production adapters.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveStats, LOG_ALLOWED_FIELDS, toIsoUtcMs, type Evidence, type ToolName } from '@traceops/contracts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
export const FX = join(ROOT, 'packages', 'contracts', 'fixtures', 'S1');
const read = (f: string) => JSON.parse(readFileSync(join(FX, f), 'utf8'));
export const manifest = read('manifest.json');
export const WINDOW = { start: toIsoUtcMs(manifest.start), end: toIsoUtcMs(manifest.end) };
const INV = '00000000-0000-4000-8000-000000000001';
let seq = 0;
export const resetEvidenceIds = () => { seq = 0; };

const thin = <T>(xs: T[], max = 60) => { const step = Math.max(1, Math.ceil(xs.length / max)); return xs.filter((_, i) => i % step === 0); };
const statsOf = (vals: number[]) => ({ min: Math.min(...vals), max: Math.max(...vals), avg: Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)), first: vals[0]!, last: vals.at(-1)!, points: vals.length });

export function queryMetricOutput(metric: string) {
  const raw = read(`prom-${metric}.json`);
  const pts: [string, number][] = (raw.data.result[0]?.values ?? []).filter((v: [number, string]) => v[1] !== 'NaN').map((v: [number, string]) => [toIsoUtcMs(v[0], 's'), Number(v[1])]);
  if (!pts.length) return { status: 'empty', metric, window: WINDOW, step_s: 15, stats: null, max_at: null, series: [], error: null };
  const stats = statsOf(pts.map((p) => p[1]));
  return { status: 'ok', metric, unit: '', window: WINDOW, step_s: 15, stats, max_at: pts.find((p) => p[1] === stats.max)![0], series: thin(pts), error: null };
}

function logLines(file: string) {
  const raw = read(file);
  const lines: Record<string, unknown>[] = [];
  for (const s of raw.data.result) for (const v of s.values) {
    const md = v[2]?.structuredMetadata ?? {};
    const line: Record<string, unknown> = { timestamp: toIsoUtcMs(v[0], 'ns'), message: v[1] };
    for (const f of LOG_ALLOWED_FIELDS) if (!(f in line)) line[f] = md[f] ?? null; // allowlist only
    line.status = line.status == null ? null : Number(line.status);
    line.duration_ms = line.duration_ms == null ? null : Number(line.duration_ms);
    lines.push(line);
  }
  return lines.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

export function searchLogsOutput(limit = 5) {
  const lines = logLines('loki-search-errors-exception.json');
  return { status: lines.length ? 'ok' : 'empty', window: WINDOW, lines: lines.slice(0, limit), truncated: lines.length > limit, error: null };
}

export function logPatternsOutput() {
  const lines = logLines('loki-patterns-sample.json');
  const g = new Map<string, any>();
  for (const l of lines) {
    const k = `${l.severity_text}|${l.message}|${l.exception_message ?? ''}`;
    const e = g.get(k) ?? { severity_text: l.severity_text, message: l.message, exception_message: l.exception_message ?? null, count: 0, first_at: l.timestamp, last_at: l.timestamp, service_versions: new Set() };
    e.count++; e.last_at = l.timestamp; if (l.service_version) e.service_versions.add(l.service_version); g.set(k, e);
  }
  const patterns = [...g.values()].sort((a, b) => b.count - a.count).slice(0, 15).map((p, i) => ({ rank: i + 1, ...p, service_versions: [...p.service_versions] }));
  return { status: 'ok', window: WINDOW, sampled_lines: lines.length, patterns, error: null };
}

export function logVolumeOutput() {
  const raw = read('loki-volume.json');
  const by: Record<string, unknown> = {};
  for (const r of raw.data.result) {
    const pts: [string, number][] = r.values.map((v: [number, string]) => [toIsoUtcMs(v[0], 's'), Number(v[1])]);
    const vals = pts.map((p) => p[1]);
    by[r.metric.severity_text] = { stats: { ...statsOf(vals), sum: vals.reduce((a, b) => a + b, 0) }, series: thin(pts) };
  }
  return { status: 'ok', window: WINDOW, step_s: 60, by_severity: by, error: null };
}

/** Wrap an output as an Evidence row exactly as the tool layer will (stats via deriveStats). */
export function toEvidence(tool: ToolName, args: unknown, output: Record<string, unknown>): Evidence {
  const id = `ev_${++seq}`;
  const result = { evidence_id: id, ...output };
  return {
    id, investigation_id: INV, tool, source: tool === 'query_metric' ? 'prometheus' : 'loki', args, rendered_query: null,
    window: WINDOW, status: output.status as Evidence['status'], error: null, result, stats: deriveStats(tool, result),
    duration_ms: 0, created_at: toIsoUtcMs(Date.now()),
  };
}
