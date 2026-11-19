import { describe, expect, it } from 'vitest';
import {
  Evidence, LOG_LINE_KEYS, METRIC_NAMES, METRIC_TEMPLATES, TOOL_OUTPUTS, STATS_KEY_GRAMMAR, deriveStats, resolveField,
  structuredOutputProblems, toIsoUtcMs, type ToolName,
} from '@traceops/contracts';
import { createTools } from '../../src/tools/index.ts';
import { groupLines, normalise } from '../../src/tools/log-patterns.ts';
import { toLogLine } from '../../src/tools/loglines.ts';
import { lokiQueryLogs } from '../../src/tools/backend/index.ts';
import { harness, loadFixture, loadFixtureText, replayFetch, scenarioIncident, type Scenario } from './helpers.ts';

const SCENARIOS: Scenario[] = ['S1', 'S2'];
const LOG_FIXTURES = ['loki-search-errors-exception.json', 'loki-search-warn.json'] as const;

/** Every row/output pair must satisfy the frozen contracts. */
function expectContractValid(tool: ToolName, row: Evidence, output: unknown) {
  expect(Evidence.safeParse(row).error).toBeUndefined();
  expect(TOOL_OUTPUTS[tool].safeParse(output).error).toBeUndefined();
  expect(row.result).toBe(output); // "exactly what the model saw"
  expect(row.tool).toBe(tool);
  expect(row.source).toBe(tool === 'query_metric' ? 'prometheus' : 'loki');
  for (const k of Object.keys(row.stats)) expect(k).toMatch(STATS_KEY_GRAMMAR[tool]);
  expect(row.stats).toEqual(deriveStats(tool, output));
}

// ── replay every fixture through its adapter ────────────────────────────────

describe.each(SCENARIOS)('query_metric replays every %s Prometheus fixture', (sc) => {
  it.each(METRIC_NAMES)('%s', async (metric) => {
    const h = harness(sc, [loadFixtureText(sc, `prom-${metric}.json`)]);
    const out = await h.call('query_metric', { metric, window: 'incident' });

    expect(h.rows).toHaveLength(1);
    const row = h.rows[0]!;
    expectContractValid('query_metric', row, out);

    // the model's name became the template, the window became the incident window
    const template = METRIC_TEMPLATES[metric].promql.replaceAll('$svc', 'demo-service');
    expect(row.rendered_query).toBe(template);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.url.searchParams.get('query')).toBe(template);
    expect(row.window).toEqual(h.windows.incident);
    expect(row.args).toEqual({ metric, window: h.windows.incident });
    expect(out.unit).toBe(METRIC_TEMPLATES[metric].unit);

    // what Prometheus sent vs what the model sees
    const raw = (loadFixture(sc, `prom-${metric}.json`) as any).data.result[0].values as [number, string][];
    const finite = raw.filter(([, v]) => Number.isFinite(Number(v)));
    expect(out.series).toHaveLength(finite.length);
    expect(out.series.length).toBeLessThanOrEqual(60);
    expect(out.series[0]).toEqual([toIsoUtcMs(finite[0]![0], 's'), Number(finite[0]![1])]);
    expect(out.stats.points).toBe(finite.length);
    expect(out.stats.max).toBe(Math.max(...finite.map(([, v]) => Number(v))));
    expect(out.series.find(([t]: [string, number]) => t === out.max_at)?.[1]).toBe(out.stats.max);
    expect(out.status).toBe('ok');
    // report values can cite what we emit
    expect(resolveField(row, 'max')).toBe(out.stats.max);
    expect(resolveField(row, `series@${out.series[0][0]}`)).toBe(out.series[0][1]);
  });
});

describe('S2 NaN handling', () => {
  it('drops NaN points instead of reporting them as numbers', async () => {
    const h = harness('S2', [loadFixtureText('S2', 'prom-db_operation_p95.json')]);
    const out = await h.call('query_metric', { metric: 'db_operation_p95', window: 'incident' });
    const raw = (loadFixture('S2', 'prom-db_operation_p95.json') as any).data.result[0].values as [number, string][];
    expect(raw.some(([, v]) => v === 'NaN')).toBe(true);
    expect(out.series.length).toBe(raw.filter(([, v]) => v !== 'NaN').length);
    expect(out.series.every(([, v]: [string, number]) => Number.isFinite(v))).toBe(true);
  });
});

describe.each(SCENARIOS)('search_logs replays every %s Loki fixture', (sc) => {
  it.each(LOG_FIXTURES)('%s', async (file) => {
    const h = harness(sc, [loadFixtureText(sc, file)]);
    const out = await h.call('search_logs', { window: 'incident', severity: file.includes('warn') ? 'warn' : 'error', match: null, limit: 50 });
    const row = h.rows[0]!;
    expectContractValid('search_logs', row, out);
    expect(out.status).toBe('ok');
    expect(out.lines.length).toBeGreaterThan(0);
    expect(row.rendered_query).toBe(`{service_name="demo-service"} | severity_text="${file.includes('warn') ? 'warn' : 'error'}"`);

    for (const line of out.lines) expect(Object.keys(line)).toEqual([...LOG_LINE_KEYS]);
    const dump = JSON.stringify([out, row]);
    for (const banned of ['exception_stacktrace', 'trace_id', 'span_id', 'host_name', 'process_pid', 'service_instance_id', 'detected_level']) {
      expect(dump).not.toContain(banned);
    }
    // newest first
    for (let i = 1; i < out.lines.length; i++) expect(out.lines[i - 1].timestamp >= out.lines[i].timestamp).toBe(true);
  });

  it('parses Loki string status / duration_ms to numbers and nanosecond timestamps to IsoUtcMs', async () => {
    const h = harness(sc, [loadFixtureText(sc, 'loki-search-errors-exception.json')]);
    const out = await h.call('search_logs', { window: 'incident', severity: 'error', match: null, limit: 50 });
    const fx = loadFixture(sc, 'loki-search-errors-exception.json') as any;
    const entries = fx.data.result.flatMap((s: any) => s.values) as [string, string, any][];
    const withStatus = entries.find((e) => e[2]?.structuredMetadata?.status);
    expect(withStatus).toBeDefined();
    const expected = out.lines.find((l: any) => l.timestamp === toIsoUtcMs(withStatus![0], 'ns'));
    expect(expected).toBeDefined();
    expect(typeof expected.status).toBe('number');
    expect(expected.status).toBe(Number(withStatus![2].structuredMetadata.status));
    for (const l of out.lines) {
      expect(l.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      if (l.duration_ms !== null) expect(typeof l.duration_ms).toBe('number');
    }
    expect(out.lines.some((l: any) => typeof l.duration_ms === 'number')).toBe(
      entries.some((e) => e[2]?.structuredMetadata?.duration_ms !== undefined),
    );
    // stats cite them by index
    const i = out.lines.indexOf(expected) + 1;
    expect(h.rows[0]!.stats[`l${i}.status`]).toBe(expected.status);
  });

  it('log_patterns', async () => {
    const h = harness(sc, [loadFixtureText(sc, 'loki-patterns-sample.json')]);
    const out = await h.call('log_patterns', { window: 'incident', severity: null });
    const row = h.rows[0]!;
    expectContractValid('log_patterns', row, out);
    expect(out.status).toBe('ok');
    expect(row.rendered_query).toBe('{service_name="demo-service"}');
    expect(h.calls[0]!.url.searchParams.get('limit')).toBe('500');
    const raw = (loadFixture(sc, 'loki-patterns-sample.json') as any).data.result.flatMap((s: any) => s.values);
    expect(out.sampled_lines).toBe(raw.length);
    out.patterns.forEach((p: any, i: number) => {
      expect(p.rank).toBe(i + 1);
      if (i) expect(out.patterns[i - 1].count >= p.count).toBe(true);
      expect(p.first_at <= p.last_at).toBe(true);
    });
    expect(out.patterns.reduce((a: number, p: any) => a + p.count, 0)).toBeLessThanOrEqual(out.sampled_lines);
    expect(JSON.stringify(out)).not.toContain('exception_stacktrace');
  });

  it('log_volume', async () => {
    const h = harness(sc, [loadFixtureText(sc, 'loki-volume.json')]);
    const out = await h.call('log_volume', { window: 'incident' });
    const row = h.rows[0]!;
    expectContractValid('log_volume', row, out);
    expect(out.status).toBe('ok');
    expect(out.step_s).toBe(60);
    expect(row.rendered_query).toBe('sum by (severity_text) (count_over_time({service_name="demo-service"}[1m]))');
    for (const sev of Object.keys(out.by_severity)) expect(['error', 'warn', 'info']).toContain(sev);
    const raw = (loadFixture(sc, 'loki-volume.json') as any).data.result as any[];
    const err = raw.find((s) => s.metric.severity_text === 'error');
    if (err) expect(out.by_severity.error.stats.sum).toBe(err.values.reduce((a: number, [, v]: [number, string]) => a + Number(v), 0));
    expect(row.stats['total.sum']).toBe(Object.values<any>(out.by_severity).reduce((a, v) => a + v.stats.sum, 0));
  });
});

// ── invalid input, windows, empty, budget ───────────────────────────────────

describe('invalid input', () => {
  const big = 'x'.repeat(101);
  const W = 'incident';
  const cases: [string, string, unknown][] = [
    ['unknown metric', 'query_metric', { metric: 'cpu_temp', window: W }],
    ['missing window', 'query_metric', { metric: 'latency_p95' }],
    ['extra key (service is not an argument)', 'query_metric', { metric: 'latency_p95', window: W, service: 'other' }],
    ['not an object', 'query_metric', null],
    ['limit above 50', 'search_logs', { window: W, severity: null, match: null, limit: 51 }],
    ['limit below 1', 'search_logs', { window: W, severity: null, match: null, limit: 0 }],
    ['non-integer limit', 'search_logs', { window: W, severity: null, match: null, limit: 1.5 }],
    ['empty contains', 'search_logs', { window: W, severity: null, match: { field: 'message', contains: '' }, limit: null }],
    ['contains too long', 'search_logs', { window: W, severity: null, match: { field: 'message', contains: big }, limit: null }],
    ['bad severity', 'log_patterns', { window: W, severity: 'fatal' }],
    ['window longer than 60 min', 'log_volume', { window: { start: '2026-11-16T17:30:00.000Z', end: '2026-11-16T18:30:00.001Z' } }],
    ['window end before start', 'log_volume', { window: { start: '2026-11-16T18:10:00.000Z', end: '2026-11-16T18:00:00.000Z' } }],
    ['window without a zone', 'log_volume', { window: { start: '2026-11-16T18:00:00', end: '2026-11-16T18:10:00' } }],
    ['window not a date', 'log_volume', { window: { start: 'yesterday', end: 'now' } }],
    ['window is an unknown keyword', 'log_volume', { window: 'last_hour' }],
    // v1.5: a JSON string is decoded once; only an object result is used, otherwise the raw string is invalid
    ['JSON string that is not JSON', 'search_logs', '{"window": incident, "severity": "error", "match": null, "limit": 20}'],
    ['JSON string of an array', 'query_metric', '["latency_p95", "incident"]'],
    ['JSON string of a string (decoded once only)', 'query_metric', JSON.stringify(JSON.stringify({ metric: 'latency_p95', window: W }))],
    ['JSON string of null', 'query_metric', 'null'],
    ['JSON string of an object that fails the checks', 'query_metric', JSON.stringify({ metric: 'cpu_temp', window: W })],
  ];
  it.each(cases)('%s → error row with raw args, no backend call', async (_n, tool, args) => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-empty.json')]);
    const out = await h.call(tool, args);
    expect(h.calls).toHaveLength(0);
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/^invalid_input: /);
    expect(out.error.length).toBeLessThanOrEqual(300);
    expect(out.evidence_id).toBe('ev_1');
    const row = h.rows[0]!;
    expect(h.rows).toHaveLength(1);
    expect(Evidence.safeParse(row).error).toBeUndefined();
    expect(row.args).toEqual(args);
    expect(row.rendered_query).toBeNull();
    expect(row.window).toBeNull();
    expect(row.status).toBe('error');
    expect(row.stats).toEqual({});
    expect(row.result).toBe(out);
  });
});

describe('v1.5: JSON-string arguments are decoded once', () => {
  it('a JSON string holding an object runs like that object; the row stores the resolved args', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    const out = await h.call('query_metric', JSON.stringify({ metric: 'pool_used', window: 'incident' }));
    expect(out.status).toBe('ok');
    expect(h.calls).toHaveLength(1);
    const row = h.rows[0]!;
    expect(Evidence.safeParse(row).error).toBeUndefined();
    expect(row.args).toEqual({ metric: 'pool_used', window: h.windows.incident });
    expect(row.rendered_query).not.toBeNull();
  });
});

describe('window outside allowed', () => {
  it.each([
    ['starts before allowed', (a: any) => ({ start: new Date(Date.parse(a.start) - 1).toISOString(), end: a.end })],
    ['ends after the investigation start', (a: any) => ({ start: a.start, end: new Date(Date.parse(a.end) + 1).toISOString() })],
  ])('%s', async (_n, mk) => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    const a = h.windows.allowed;
    const span = (w: any) => ({ start: new Date(Math.max(Date.parse(w.start), Date.parse(w.end) - 30 * 60_000)).toISOString(), end: w.end });
    // 30 minute windows hugging the boundary, then pushed over it
    const edge = _n.startsWith('starts')
      ? { start: new Date(Date.parse(a.start) - 1).toISOString(), end: new Date(Date.parse(a.start) + 29 * 60_000).toISOString() }
      : span(mk(a));
    const out = await h.call('query_metric', { metric: 'pool_used', window: edge });
    expect(h.calls).toHaveLength(0);
    expect(out.status).toBe('error');
    expect(out.error).toContain('window must lie within');
    expect(h.rows[0]!.rendered_query).toBeNull();
    expect(h.rows[0]!.window).toBeNull();
    expect(h.rows[0]!.args).toEqual({ metric: 'pool_used', window: edge });
  });

  it('accepts an explicit window inside allowed, normalising a non-UTC offset', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    const out = await h.call('query_metric', { metric: 'pool_used', window: { start: '2026-11-16T23:53:39.000+05:30', end: '2026-11-17T00:00:39+05:30' } });
    expect(out.status).toBe('ok');
    expect(out.window).toEqual({ start: '2026-11-16T18:23:39.000Z', end: '2026-11-16T18:30:39.000Z' });
  });

  it('"baseline" resolves to the baseline window', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    const out = await h.call('query_metric', { metric: 'pool_used', window: 'baseline' });
    expect(out.window).toEqual(h.windows.baseline);
  });
});

describe('internal failure still records exactly one evidence row', () => {
  it('a malformed Loki timestamp makes execute throw: error row, sanitized, ids contiguous', async () => {
    const fx = loadFixture('S1', 'loki-search-warn.json') as any;
    const bad = JSON.parse(JSON.stringify(fx));
    bad.data.result[0].values[0][0] = 'not-a-number Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const h = harness('S1', [JSON.stringify(bad), loadFixtureText('S1', 'loki-search-warn.json')]);
    const a = await h.call('search_logs', { window: 'incident', severity: 'warn', match: null, limit: null });
    const b = await h.call('search_logs', { window: 'incident', severity: 'warn', match: null, limit: null });
    expect(h.rows.map((r) => r.id)).toEqual(['ev_1', 'ev_2']);
    expect(a).toMatchObject({ evidence_id: 'ev_1', status: 'error' });
    expect(h.rows[0]!.status).toBe('error');
    expect(h.rows[0]!.stats).toEqual({});
    expect(h.rows[0]!.rendered_query).not.toBeNull();
    expect(h.rows[0]!.error!.startsWith('internal_error')).toBe(true);
    expect(h.rows[0]!.error!.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(h.rows[0])).not.toContain('abcdefghijklmnop');
    // like invalid-input rows, the model-facing output is the short early form
    expect(Evidence.safeParse(h.rows[0]).error).toBeUndefined();
    expect(h.rows[0]!.result).toBe(a);
    expect(b.status).toBe('ok');
  });
});

describe('empty is never zero', () => {
  it('query_metric: empty Prometheus result → status empty, stats null, no stats keys', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-empty.json')]);
    const out = await h.call('query_metric', { metric: 'pool_used', window: 'incident' });
    expect(out).toMatchObject({ status: 'empty', stats: null, max_at: null, series: [], error: null });
    expect(h.rows[0]!.status).toBe('empty');
    expect(h.rows[0]!.stats).toEqual({});
    expectContractValid('query_metric', h.rows[0]!, out);
  });

  it('query_metric: a series of only NaN points is also empty', async () => {
    // Real captured response with every sample value replaced by NaN.
    const fx = loadFixture('S1', 'prom-latency_p95.json') as any;
    const nan = JSON.stringify({ ...fx, data: { ...fx.data, result: fx.data.result.map((s: any) => ({ ...s, values: s.values.map(([t]: [number, string]) => [t, 'NaN']) })) } });
    const h = harness('S1', [nan]);
    const out = await h.call('query_metric', { metric: 'latency_p95', window: 'incident' });
    expect(out.status).toBe('empty');
    expect(out.series).toEqual([]);
  });

  // Empty Loki results are derived from a real captured response by removing its entries.
  const emptied = (file: string) => {
    const fx = loadFixture('S1', file) as any;
    return JSON.stringify({ ...fx, data: { ...fx.data, result: [] } });
  };
  it('search_logs, log_patterns, log_volume', async () => {
    const h = harness('S1', [emptied('loki-search-warn.json'), emptied('loki-patterns-sample.json'), emptied('loki-volume.json')]);
    const a = await h.call('search_logs', { window: 'incident', severity: 'warn', match: null, limit: null });
    const b = await h.call('log_patterns', { window: 'incident', severity: null });
    const c = await h.call('log_volume', { window: 'incident' });
    expect([a.status, b.status, c.status]).toEqual(['empty', 'empty', 'empty']);
    expect(a.lines).toEqual([]);
    expect(b.patterns).toEqual([]);
    expect(c.by_severity).toEqual({});
    h.rows.forEach((r) => expect(r.stats).toEqual({}));
    expectContractValid('search_logs', h.rows[0]!, a);
    expectContractValid('log_patterns', h.rows[1]!, b);
    expectContractValid('log_volume', h.rows[2]!, c);
  });
});

describe('budget', () => {
  it('after maxToolCalls, tools return budget_exhausted rows and send nothing', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')], { budget: { maxToolCalls: 2, deadline: Date.now() + 60_000 } });
    const args = { metric: 'pool_used', window: 'incident' };
    expect((await h.call('query_metric', args)).status).toBe('ok');
    expect((await h.call('query_metric', args)).status).toBe('ok');
    const third = await h.call('query_metric', args);
    expect(third).toMatchObject({ evidence_id: 'ev_3', status: 'budget_exhausted' });
    expect(third.error).toMatch(/^budget_exhausted/);
    expect(h.calls).toHaveLength(2);
    expect(h.rows).toHaveLength(3);
    const row = h.rows[2]!;
    expect(Evidence.safeParse(row).error).toBeUndefined();
    expect(row).toMatchObject({ id: 'ev_3', status: 'budget_exhausted', rendered_query: null, window: null, args, stats: {} });
    // a budget-exhausted call is a call: the fourth is also refused
    expect((await h.call('log_volume', { window: 'incident' })).status).toBe('budget_exhausted');
  });

  it('the budget applies to invalid calls too, and is checked before validation', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')], { budget: { maxToolCalls: 1, deadline: Date.now() + 60_000 } });
    expect((await h.call('query_metric', { nope: true })).status).toBe('error');
    expect((await h.call('query_metric', { nope: true })).status).toBe('budget_exhausted');
  });

  it('v1.5: query_metric gets at most maxToolCalls - logCallReserve calls; log tools keep the rest', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]); // maxToolCalls 12
    const args = { metric: 'pool_used', window: 'incident' };
    for (let i = 1; i <= 8; i++) expect((await h.call('query_metric', args)).status).toBe('ok');
    const ninth = await h.call('query_metric', args);
    expect(ninth).toMatchObject({ evidence_id: 'ev_9', status: 'budget_exhausted' });
    expect(ninth.error).toBe('budget_exhausted: query_metric limit reached (8 of 12 calls); the remaining calls are reserved for log tools (log_volume, log_patterns, search_logs)');
    expect(h.calls).toHaveLength(8); // nothing sent for the refused call
    const row = h.rows[8]!;
    expect(Evidence.safeParse(row).error).toBeUndefined();
    expect(row).toMatchObject({ id: 'ev_9', tool: 'query_metric', status: 'budget_exhausted', rendered_query: null, window: null, args, stats: {} });
    // log tools still run; the refused call counted toward the 12 (ev_10..ev_12 are left)
    for (const id of ['ev_10', 'ev_11', 'ev_12']) {
      const out = await h.call('log_volume', { window: 'incident' });
      expect(out.evidence_id).toBe(id);
      expect(out.status).not.toBe('budget_exhausted');
    }
    expect((await h.call('log_volume', { window: 'incident' })).error).toMatch(/^budget_exhausted: the tool budget is used up/);
    expect(h.rows.map((r) => r.id)).toEqual(Array.from({ length: 13 }, (_, i) => `ev_${i + 1}`));
  });

  it('v1.5: the metric limit counts invalid query_metric calls too, and not log calls', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    for (let i = 0; i < 3; i++) await h.call('log_volume', { window: 'incident' });
    for (let i = 0; i < 8; i++) await h.call('query_metric', i === 0 ? { nope: true } : { metric: 'pool_used', window: 'incident' });
    expect(h.rows.slice(3).map((r) => r.status)).toEqual(['error', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect((await h.call('query_metric', { metric: 'pool_used', window: 'incident' })).error).toMatch(/query_metric limit reached/);
  });

  it('after the deadline, tools return budget_exhausted', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')], { budget: { maxToolCalls: 12, deadline: Date.now() - 1 } });
    const out = await h.call('query_metric', { metric: 'pool_used', window: 'incident' });
    expect(out.status).toBe('budget_exhausted');
    expect(h.calls).toHaveLength(0);
    expect(h.rows[0]!.status).toBe('budget_exhausted');
  });
});

describe('numbering', () => {
  it('ev_1…ev_n in call order, one row per call, across tools', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    await h.call('query_metric', { metric: 'pool_used', window: 'incident' });
    await h.call('log_patterns', { window: 'incident', severity: 'bad' });
    await h.call('query_metric', { metric: 'pool_used', window: 'baseline' });
    expect(h.rows.map((r) => r.id)).toEqual(['ev_1', 'ev_2', 'ev_3']);
    expect(h.rows.map((r) => r.tool)).toEqual(['query_metric', 'log_patterns', 'query_metric']);
    expect(new Set(h.rows.map((r) => r.investigation_id))).toEqual(new Set(['3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f']));
  });

  it('parallel calls are numbered in request order', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    const outs = await Promise.all([
      h.call('query_metric', { metric: 'pool_used', window: 'incident' }),
      h.call('query_metric', { metric: 'pool_used', window: 'baseline' }),
      h.call('query_metric', { metric: 'pool_used', window: 'incident' }),
    ]);
    expect(outs.map((o) => o.evidence_id)).toEqual(['ev_1', 'ev_2', 'ev_3']);
    expect(h.rows.map((r) => r.id).sort()).toEqual(['ev_1', 'ev_2', 'ev_3']);
  });

  it('each createTools(ctx) starts again at ev_1', async () => {
    const a = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    const b = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    await a.call('query_metric', { metric: 'pool_used', window: 'incident' });
    expect((await b.call('query_metric', { metric: 'pool_used', window: 'incident' })).evidence_id).toBe('ev_1');
  });
});

// ── backend failure ─────────────────────────────────────────────────────────

describe('backend failures', () => {
  it('network error → error row; text is sanitised; the query is recorded because it was sent', async () => {
    const h = harness('S1', [new TypeError('connect ECONNREFUSED 10.1.2.3:9090 http://prom.internal/api/v1/query_range?query=sum(rate(x))')]);
    const out = await h.call('query_metric', { metric: 'latency_p95', window: 'incident' });
    expect(out.status).toBe('error');
    expect(out.error).toBe('backend_error: prometheus unreachable');
    expect(h.calls).toHaveLength(2); // one retry
    const row = h.rows[0]!;
    expectContractValid('query_metric', row, out);
    expect(row.rendered_query).toContain('histogram_quantile');
    expect(row.window).toEqual(h.windows.incident);
    expect(row.stats).toEqual({});
    const dump = JSON.stringify([out, row.error, row.result]);
    for (const leak of ['10.1.2.3', 'prom.internal', 'ECONNREFUSED', 'query_range']) expect(dump).not.toContain(leak);
  });

  it('Prometheus error body (HTTP 400): no PromQL or URL reaches the model or the row', async () => {
    const h = harness('S1', [{ status: 400, body: loadFixtureText('S1', 'prom-error-badquery.json') }]);
    const out = await h.call('query_metric', { metric: 'latency_p95', window: 'incident' });
    expect(out.status).toBe('error');
    expect(out.error).toBe('backend_error: prometheus rejected the query (bad_data)');
    expect(h.calls).toHaveLength(1);
    expect(JSON.stringify(h.rows[0])).not.toContain('parenthesis');
    expectContractValid('query_metric', h.rows[0]!, out);
  });

  it('Loki failures produce schema-valid error outputs for each Loki tool', async () => {
    const h = harness('S1', [{ status: 500, body: 'rpc error: code = Unknown desc = http://loki-internal:3100 {service_name="demo-service"}' }]);
    const a = await h.call('search_logs', { window: 'incident', severity: null, match: null, limit: null });
    const b = await h.call('log_patterns', { window: 'incident', severity: null });
    const c = await h.call('log_volume', { window: 'incident' });
    for (const o of [a, b, c]) {
      expect(o.status).toBe('error');
      expect(o.error).toBe('backend_error: loki returned a non-JSON response');
    }
    expectContractValid('search_logs', h.rows[0]!, a);
    expectContractValid('log_patterns', h.rows[1]!, b);
    expectContractValid('log_volume', h.rows[2]!, c);
    expect(JSON.stringify(h.rows)).not.toContain('loki-internal');
  });

  it('a caller abort records one row then throws (the tool loop reports tool_error)', async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')]);
    await expect(h.call('query_metric', { metric: 'pool_used', window: 'incident' }, ac.signal)).rejects.toThrow('aborted');
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ status: 'error', error: 'aborted' });
    expect(h.calls).toHaveLength(0);
  });

  it('ToolContext.signal aborts too', async () => {
    const ac = new AbortController();
    ac.abort();
    const h = harness('S1', [loadFixtureText('S1', 'loki-volume.json')], { signal: ac.signal });
    await expect(h.call('log_volume', { window: 'incident' })).rejects.toThrow('aborted');
    expect(h.rows).toHaveLength(1);
  });

  it('an evidence sink failure surfaces (the tool does not pretend the row was stored)', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'prom-pool_used.json')], { evidence: { append: async () => { throw new Error('db down'); } } });
    await expect(h.call('query_metric', { metric: 'pool_used', window: 'incident' })).rejects.toThrow('db down');
  });
});

// ── allowlist, redaction, rendering of model text ───────────────────────────

describe('log content', () => {
  it('redacts and truncates every string before storage', async () => {
    const text = loadFixtureText('S1', 'loki-search-errors-exception.json')
      .replaceAll('"request failed"', JSON.stringify('upstream rejected Authorization: Bearer abcDEF123456789xyz for jane.doe@example.com'))
      .replaceAll('"timeout exceeded when trying to connect"', JSON.stringify(`connect to postgres://shop:hunter2pw@db:5432/shop failed ${'z'.repeat(600)}`));
    const h = harness('S1', [text]);
    const out = await h.call('search_logs', { window: 'incident', severity: 'error', match: null, limit: 50 });
    const dump = JSON.stringify([out, h.rows[0]]);
    for (const secret of ['abcDEF123456789xyz', 'jane.doe', 'hunter2pw']) expect(dump).not.toContain(secret);
    expect(dump).toContain('[REDACTED]');
    for (const l of out.lines) for (const v of Object.values<any>(l)) if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(300);
    expect(out.lines.some((l: any) => l.exception_message?.endsWith('…'))).toBe(true);
  });

  it('unparseable status / duration_ms become null; a field absent from metadata is null', async () => {
    const fx = loadFixtureText('S1', 'loki-search-errors-exception.json');
    const net = replayFetch([fx]);
    const r = await lokiQueryLogs({ baseUrl: 'http://loki.test', query: 'q', start: '2026-11-16T18:00:00.000Z', end: '2026-11-16T18:10:00.000Z', limit: 5 }, { fetch: net.fetch });
    if (!r.ok) throw new Error('fixture replay failed');
    const base = r.data[0]!;
    const line = (md: Record<string, string>) => toLogLine({ ...base, metadata: md });
    expect(line({ status: 'abc', duration_ms: 'n/a' })).toMatchObject({ status: null, duration_ms: null });
    expect(line({ status: '500.5' }).status).toBeNull();
    expect(line({ status: ' 503 ', duration_ms: '12.5' })).toMatchObject({ status: 503, duration_ms: 12.5 });
    expect(line({ status: '1e3' }).status).toBeNull();
    const none = line({});
    expect(none).toMatchObject({ exception_type: null, exception_message: null, route: null, service_version: null, status: null, severity_text: 'unknown' });
    expect(Object.keys(none)).toEqual([...LOG_LINE_KEYS]);
  });

  it('metadata fields outside LOG_LINE_KEYS never appear, whatever Loki returns', async () => {
    const fx = loadFixtureText('S1', 'loki-search-errors-exception.json')
      .replaceAll('"exception_stacktrace": "<scrubbed>"', '"exception_stacktrace": "at Pool.connect (/srv/app/db.js:10:5)", "db_password": "p4ss", "authorization": "Bearer zzz"');
    const h = harness('S1', [fx]);
    const out = await h.call('search_logs', { window: 'incident', severity: 'error', match: null, limit: 50 });
    const dump = JSON.stringify([out, h.rows[0]]);
    for (const banned of ['exception_stacktrace', 'Pool.connect', 'db_password', 'p4ss', 'authorization', 'zzz']) expect(dump).not.toContain(banned);
  });

  it('model-supplied match text is escaped in the rendered query and cannot add pipeline stages', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'loki-search-warn.json')]);
    const evil = 'x" | json | line_format "{{.password}}';
    await h.call('search_logs', { window: 'incident', severity: null, match: { field: 'message', contains: evil }, limit: 5 });
    const q = h.rows[0]!.rendered_query!;
    expect(q).toBe(`{service_name="demo-service"} |= ${JSON.stringify(evil)}`);
    expect(h.calls[0]!.url.searchParams.get('query')).toBe(q);
    expect(h.calls[0]!.url.searchParams.get('limit')).toBe('5');
  });

  it('search_logs: default limit 20, truncated flag when the backend filled the limit', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'loki-search-warn.json')]);
    const out = await h.call('search_logs', { window: 'incident', severity: 'warn', match: null, limit: null });
    expect(h.calls[0]!.url.searchParams.get('limit')).toBe('20');
    expect(out.lines.length).toBe(20);
    expect(out.truncated).toBe(true);
    const h2 = harness('S1', [loadFixtureText('S1', 'loki-search-warn.json')]);
    const out2 = await h2.call('search_logs', { window: 'incident', severity: 'warn', match: null, limit: 50 });
    expect(out2.truncated).toBe(false);
  });

  it('exception_message match renders a case-insensitive escaped regex', async () => {
    const h = harness('S1', [loadFixtureText('S1', 'loki-search-errors-exception.json')]);
    await h.call('search_logs', { window: 'incident', severity: 'error', match: { field: 'exception_message', contains: 'timeout (x)' }, limit: 5 });
    expect(h.rows[0]!.rendered_query).toBe('{service_name="demo-service"} | severity_text="error" | exception_message=~"(?i).*timeout \\\\(x\\\\).*"');
  });
});

// ── log_patterns grouping ───────────────────────────────────────────────────

describe('log_patterns normalisation and grouping', () => {
  it.each([
    ['order 6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f failed', 'order <uuid> failed'],
    ['timeout after 5000ms on attempt 3', 'timeout after <n> on attempt <n>'],
    ['trace 0xdeadbeef and a1b2c3d4e5f6 seen', 'trace <hex> and <hex> seen'],
    ['upgrade to v1.0.1 done', 'upgrade to v1.0.1 done'],
    ['GET /orders/42 returned 500', 'GET /orders/42 returned <n>'],
    ['ratio 0.47 of 10', 'ratio <n> of <n>'],
  ])('%s', (input, expected) => expect(normalise(input)).toBe(expected));

  it('groups by severity + normalised message + exception, ranks by count, tracks versions and times', () => {
    const mk = (message: string, ts: string, v: string | null, sev = 'error', ex: string | null = null) =>
      ({ timestamp: ts, message, severity_text: sev, exception_type: null, exception_message: ex, route: null, status: null, duration_ms: null, service_version: v });
    const groups = groupLines([
      mk('request 1 failed', '2026-11-16T18:00:03.000Z', '1.0.0'),
      mk('request 2 failed', '2026-11-16T18:00:01.000Z', '1.0.1'),
      mk('request 99 failed', '2026-11-16T18:00:02.000Z', '1.0.1'),
      mk('slow query', '2026-11-16T18:00:05.000Z', null, 'warn'),
      mk('request 5 failed', '2026-11-16T18:00:04.000Z', '1.0.1', 'warn'),
    ]);
    expect(groups.map((g) => [g.severity, g.message, g.count])).toEqual([
      ['error', 'request <n> failed', 3], ['warn', 'request <n> failed', 1], ['warn', 'slow query', 1],
    ]);
    expect(groups[0]).toMatchObject({ first: '2026-11-16T18:00:01.000Z', last: '2026-11-16T18:00:03.000Z' });
    expect([...groups[0]!.versions].sort()).toEqual(['1.0.0', '1.0.1']);
  });
});

// ── the seam ────────────────────────────────────────────────────────────────

describe('createTools (the seam)', () => {
  const { incident, investigationStart } = scenarioIncident('S1');
  const ctx = {
    investigationId: '3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f', incident, investigationStart, prometheusUrl: 'http://p', lokiUrl: 'http://l',
    evidence: { append: async () => {} }, budget: { maxToolCalls: 12, deadline: Date.now() + 1000 },
  };
  const tools = createTools(ctx);

  it('returns exactly the four tools, in contract order', () => {
    expect(tools.map((t) => t.spec.name)).toEqual(['query_metric', 'search_logs', 'log_patterns', 'log_volume']);
  });
  it('provider schemas satisfy the structured-output check and mention no query language or URL', () => {
    for (const t of tools) {
      expect(structuredOutputProblems(t.spec.parameters)).toEqual([]);
      const text = JSON.stringify(t.spec);
      for (const banned of ['PromQL', 'LogQL', 'http', 'histogram_quantile', 'service_name']) expect(text).not.toContain(banned);
      expect(t.spec.description.length).toBeGreaterThan(40);
    }
  });
  it('args schema accepts anything, so the loop never swallows a call before it gets an evidence row', () => {
    for (const t of tools) for (const v of [null, 1, 'x', [], {}, { metric: 1 }]) expect(t.args.safeParse(v).success).toBe(true);
  });
});
