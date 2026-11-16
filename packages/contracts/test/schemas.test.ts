import { describe, expect, it } from 'vitest';
import {
  Report, ReportApi, Incident, RuleConfig, Evidence, deriveWindows,
  METRIC_NAMES, METRIC_TEMPLATES, renderPromql, LOG_ALLOWED_FIELDS, LOG_LINE_KEYS,
  STATS_KEY_GRAMMAR, deriveStats, resolveField, TOOL_NAMES, TOOL_INPUTS, SearchLogsChecked,
  QueryMetricChecked, IsoUtcMs, toIsoUtcMs, PORTS,
} from '../src/index.ts';
import { validReport, queryMetricOut, logVolumeOut, logPatternsOut, searchLogsOut } from './examples.ts';

describe('time', () => {
  it('accepts only ISO UTC with ms', () => {
    expect(IsoUtcMs.safeParse('2026-11-16T18:03:21.123Z').success).toBe(true);
    for (const bad of ['2026-11-16T18:03:21Z', '2026-11-16T18:03:21.123+05:30', '1794850678'])
      expect(IsoUtcMs.safeParse(bad).success).toBe(false);
  });
  it('normalises Prometheus seconds and Loki nanoseconds', () => {
    expect(toIsoUtcMs(1794850678.138, 's')).toBe('2026-11-16T17:37:58.138Z');
    expect(toIsoUtcMs('1794850812250000000', 'ns')).toBe('2026-11-16T17:40:12.250Z');
  });
});

describe('telemetry ↔ tools consistency', () => {
  it('every model-facing metric has a template and renders with service bound', () => {
    expect(METRIC_NAMES.sort()).toEqual(Object.keys(METRIC_TEMPLATES).sort());
    for (const m of METRIC_NAMES) expect(renderPromql(m, 'demo-service')).not.toContain('$svc');
  });
  it('rejects injection through the service name', () => {
    expect(() => renderPromql('pool_used', 'x"} or vector(1) #')).toThrow();
  });
  it('log line schema keys equal the allowlist exactly', () => {
    expect([...LOG_LINE_KEYS].sort()).toEqual([...LOG_ALLOWED_FIELDS].sort());
  });
  it('detector rules may only use symptom templates', () => {
    const base = { rules: [{ id: 'r', service: 'demo-service', group: 'http-slo', query: 'latency_p95', op: '>', threshold: 1 }],
      evaluation: { interval_s: 15, fire_after: 2, resolve_after: 4, query_timeout_s: 5, reopen_window_s: 300 } };
    expect(RuleConfig.safeParse(base).success).toBe(true);
    expect(RuleConfig.safeParse({ ...base, rules: [{ ...base.rules[0], query: 'pool_pending' }] }).success).toBe(false);
  });
  it('ports are unique', () => {
    const v = Object.values(PORTS); expect(new Set(v).size).toBe(v.length);
  });
});

describe('tool inputs', () => {
  it('every tool has an input schema', () => expect(Object.keys(TOOL_INPUTS).sort()).toEqual([...TOOL_NAMES].sort()));
  it('server-side checks enforce limits the API cannot', () => {
    const ok = { window: 'incident', severity: 'error', match: { field: 'exception_message', contains: 'timeout' }, limit: 20 };
    expect(SearchLogsChecked.safeParse(ok).success).toBe(true);
    expect(SearchLogsChecked.safeParse({ ...ok, limit: 500 }).success).toBe(false);
    expect(SearchLogsChecked.safeParse({ ...ok, match: { field: 'message', contains: 'x'.repeat(101) } }).success).toBe(false);
    expect(QueryMetricChecked.safeParse({ metric: 'pool_used', window: { start: '2026-11-16T18:00:00Z', end: '2026-11-16T19:30:00Z' } }).success).toBe(false);
  });
  it('normalises model-supplied windows to IsoUtcMs', () => {
    const r = QueryMetricChecked.parse({ metric: 'pool_used', window: { start: '2026-11-16T23:30:00+05:30', end: '2026-11-16T18:10:00Z' } });
    expect(r.window).toEqual({ start: '2026-11-16T18:00:00.000Z', end: '2026-11-16T18:10:00.000Z' });
  });
});

describe('evidence stats', () => {
  it.each([
    ['query_metric', queryMetricOut], ['log_volume', logVolumeOut], ['log_patterns', logPatternsOut], ['search_logs', searchLogsOut],
  ] as const)('%s: derived stats are flat numbers following the grammar', (tool, out) => {
    const stats = deriveStats(tool, out);
    expect(Object.keys(stats).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(stats)) {
      expect(k).toMatch(STATS_KEY_GRAMMAR[tool]);
      expect(typeof v).toBe('number');
    }
  });
  it('resolves stats keys and series points', () => {
    const ev = { tool: 'query_metric' as const, stats: deriveStats('query_metric', queryMetricOut), result: queryMetricOut };
    expect(resolveField(ev, 'max')).toBe(10);
    expect(resolveField(ev, 'series@2026-11-16T18:05:00.000Z')).toBe(10);
    expect(resolveField(ev, 'series@2026-11-16T18:05:01.000Z')).toBeUndefined();
    expect(resolveField(ev, 'p95')).toBeUndefined();
    const lv = { tool: 'log_volume' as const, stats: deriveStats('log_volume', logVolumeOut), result: logVolumeOut };
    expect(resolveField(lv, 'error.sum')).toBe(31);
    expect(resolveField(lv, 'error.series@2026-11-16T18:05:00.000Z')).toBe(12);
  });
  it('evidence for an invalid tool input is representable', () => {
    expect(Evidence.safeParse({
      id: 'ev_4', investigation_id: '7a1f2c1e-5b0e-4b7a-9d55-0f8b6f6b2b11', tool: 'search_logs', source: 'loki',
      args: { limit: 500 }, rendered_query: null, window: null, status: 'error', error: 'invalid_input: limit must be <= 50',
      result: { status: 'error' }, stats: {}, duration_ms: 0, created_at: '2026-11-16T18:06:00.000Z',
    }).success).toBe(true);
  });
});

describe('report', () => {
  it('valid example passes both API and checked schemas', () => {
    expect(ReportApi.safeParse(validReport).success).toBe(true);
    expect(Report.safeParse(validReport).success).toBe(true);
  });
  it('checked schema rejects what the API cannot enforce', () => {
    const bad = structuredClone(validReport);
    bad.observations[0]!.evidence_ids = [];
    bad.timeline[0]!.at = '2026-11-16T18:03:00Z';
    bad.observations[1]!.values[0]!.key = 'used_max'; // duplicate key
    const r = Report.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.message).sort()).toEqual(
      ['must be ISO 8601 UTC with ms', 'must cite >= 1 evidence', 'value keys must be unique across the report'].sort());
  });
  it('insufficient_evidence with no hypotheses is a valid report', () => {
    expect(Report.safeParse({ ...validReport, status: 'insufficient_evidence', hypotheses: [], recommendations: [] }).success).toBe(true);
  });
});

describe('incident', () => {
  it('parses and derives windows', () => {
    const inc = { id: '7a1f2c1e-5b0e-4b7a-9d55-0f8b6f6b2b11', fingerprint: 'a'.repeat(64), service: 'demo-service', group: 'http-slo',
      status: 'open', severity: 'critical', started_at: '2026-11-16T18:04:00.000Z', detected_at: '2026-11-16T18:04:30.000Z',
      resolved_at: null, reopen_count: 0, trigger: [{ rule_id: 'http-latency-p95', query: 'latency_p95', threshold: 1, observed: 2.1, at: '2026-11-16T18:04:30.000Z' }] };
    expect(Incident.safeParse(inc).success).toBe(true);
    const w = deriveWindows(inc.started_at, '2026-11-16T18:05:00.000Z');
    expect(w.incident).toEqual({ start: '2026-11-16T18:02:00.000Z', end: '2026-11-16T18:05:00.000Z' });
    expect(w.baseline).toEqual({ start: '2026-11-16T17:59:00.000Z', end: '2026-11-16T18:02:00.000Z' });
  });
});
