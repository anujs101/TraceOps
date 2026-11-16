import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromRangeResponse, PromErrorResponse, LokiStreamsResponse, LokiMatrixResponse, METRIC_NAMES, toIsoUtcMs, IsoUtcMs, FORBIDDEN_LOG_PHRASES } from '../src/index.ts';

const ROOT = join(import.meta.dirname, '..', 'fixtures');
const scenarios = existsSync(ROOT) ? readdirSync(ROOT).filter((d) => existsSync(join(ROOT, d, 'manifest.json'))) : [];
const load = (sc: string, f: string) => JSON.parse(readFileSync(join(ROOT, sc, f), 'utf8'));
const SCRUBBED = ['host_name', 'host_id', 'process_owner', 'process_command', 'process_command_args', 'process_executable_path', 'service_instance_id', 'instance', 'exception_stacktrace'];

describe('fixtures exist for both scenarios', () => {
  it('S1 and S2 captured', () => expect(scenarios.sort()).toEqual(['S1', 'S2']));
});

describe.each(scenarios)('fixtures %s', (sc) => {
  const files = readdirSync(join(ROOT, sc));

  it('cover every metric template', () => {
    for (const m of METRIC_NAMES) expect(files).toContain(`prom-${m}.json`);
  });

  it('match the raw backend response schemas', () => {
    for (const f of files) {
      const d = load(sc, f);
      if (f === 'manifest.json') continue;
      if (f === 'prom-error-badquery.json') expect(PromErrorResponse.safeParse(d).success).toBe(true);
      else if (f.startsWith('prom-')) expect(PromRangeResponse.safeParse(d).success, f).toBe(true);
      else if (f === 'loki-volume.json') expect(LokiMatrixResponse.safeParse(d).success, f).toBe(true);
      else expect(LokiStreamsResponse.safeParse(d).success, f).toBe(true);
    }
  });

  it('have data in the core series (capture worked)', () => {
    for (const m of ['latency_p95', 'pool_used', 'pool_max', 'eventloop_utilization']) {
      const d = PromRangeResponse.parse(load(sc, `prom-${m}.json`));
      expect(d.data.result[0]?.values.length ?? 0, m).toBeGreaterThan(10);
    }
    expect(PromRangeResponse.parse(load(sc, 'prom-empty.json')).data.result).toEqual([]);
  });

  it('timestamps convert to IsoUtcMs from both backends', () => {
    const prom = PromRangeResponse.parse(load(sc, 'prom-latency_p95.json'));
    expect(IsoUtcMs.safeParse(toIsoUtcMs(prom.data.result[0]!.values[0]![0], 's')).success).toBe(true);
    const loki = LokiStreamsResponse.parse(load(sc, 'loki-patterns-sample.json'));
    const entry = loki.data.result[0]?.values[0];
    if (entry) expect(IsoUtcMs.safeParse(toIsoUtcMs(entry[0], 'ns')).success).toBe(true);
  });

  it('Loki metadata values are strings (adapter must parse status/duration_ms)', () => {
    const loki = LokiStreamsResponse.parse(load(sc, 'loki-patterns-sample.json'));
    for (const s of loki.data.result) for (const v of s.values) {
      const md = (v[2] as any)?.structuredMetadata ?? {};
      for (const val of Object.values(md)) expect(typeof val).toBe('string');
    }
  });

  it('are scrubbed of host/user identifying values', () => {
    const text = files.map((f) => readFileSync(join(ROOT, sc, f), 'utf8')).join('\n');
    const json = files.map((f) => load(sc, f));
    const check = (x: any): void => {
      if (Array.isArray(x)) return x.forEach(check);
      if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) {
        if (SCRUBBED.includes(k) && typeof v === 'string') expect(v, k).toBe('<scrubbed>');
        check(v);
      }
    };
    json.forEach(check);
    expect(text).not.toMatch(/\/Users\/|\.local"/);
  });

  it('logs never name the root cause (ground-truth hygiene)', () => {
    for (const f of files.filter((f) => f.startsWith('loki-') && f !== 'loki-volume.json')) {
      const loki = LokiStreamsResponse.parse(load(sc, f));
      for (const s of loki.data.result) for (const v of s.values)
        for (const re of FORBIDDEN_LOG_PHRASES) expect(v[1]).not.toMatch(re);
    }
  });
});

describe('S1 fixtures show the leak signature', () => {
  it.runIf(scenarios.includes('S1'))('acquire-timeout errors present with exception_message metadata', () => {
    const loki = LokiStreamsResponse.parse(load('S1', 'loki-search-errors-exception.json'));
    const md = loki.data.result.flatMap((s) => s.values.map((v) => (v[2] as any)?.structuredMetadata ?? {}));
    expect(md.length).toBeGreaterThan(0);
    expect(md.every((m) => m.exception_message === 'timeout exceeded when trying to connect')).toBe(true);
  });
  it.runIf(scenarios.includes('S1'))('pending requests visible (export-time gauge, not stale)', () => {
    const d = PromRangeResponse.parse(load('S1', 'prom-pool_pending.json'));
    const max = Math.max(...d.data.result.flatMap((r) => r.values.map((v) => Number(v[1]))).filter(Number.isFinite));
    expect(max).toBeGreaterThan(0);
  });
});
