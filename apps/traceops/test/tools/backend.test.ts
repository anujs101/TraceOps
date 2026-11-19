import { describe, expect, it } from 'vitest';
import { lokiQueryLogs, lokiQueryMatrix, promQueryRange } from '../../src/tools/backend/index.ts';
import { loadFixture, loadFixtureText, loadManifest, replayFetch, type Scenario } from './helpers.ts';

const SCENARIOS: Scenario[] = ['S1', 'S2'];
const PROM = 'http://prom.test:9090';
const LOKI = 'http://loki.test:3100';

describe.each(SCENARIOS)('backend clients replay %s fixtures', (sc) => {
  const m = loadManifest(sc);
  const base = { start: m.start.replace('.000Z', '.000Z'), end: m.end };

  it('prometheus: query_range request shape and parsed matrix', async () => {
    const { fetch, calls } = replayFetch([loadFixtureText(sc, 'prom-pool_used.json')]);
    const r = await promQueryRange({ baseUrl: PROM, query: 'up', ...base, stepS: 15 }, { fetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.length).toBeGreaterThan(0);
    expect(typeof r.data[0]!.values[0]![1]).toBe('string');
    const u = calls[0]!.url;
    expect(u.origin + u.pathname).toBe(`${PROM}/api/v1/query_range`);
    expect(u.searchParams.get('step')).toBe('15s');
    expect(u.searchParams.get('query')).toBe('up');
    expect(u.searchParams.get('start')).toBe(base.start);
  });

  it('prometheus: empty result is ok with no series (the tool decides "empty")', async () => {
    const { fetch } = replayFetch([loadFixtureText(sc, 'prom-empty.json')]);
    const r = await promQueryRange({ baseUrl: PROM, query: 'x', ...base, stepS: 15 }, { fetch });
    expect(r).toEqual({ ok: true, data: [] });
  });

  it('prometheus: backend error body (HTTP 400) is kind=backend', async () => {
    const { fetch } = replayFetch([{ status: 400, body: loadFixtureText(sc, 'prom-error-badquery.json') }]);
    const r = await promQueryRange({ baseUrl: PROM, query: '(', ...base, stepS: 15 }, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('backend');
      expect(r.message).toContain('bad_data');
    }
  });

  it('loki logs: flattens streams, keeps structured metadata, newest first, sends categorize-labels', async () => {
    const { fetch, calls } = replayFetch([loadFixtureText(sc, 'loki-search-warn.json')]);
    const r = await lokiQueryLogs({ baseUrl: LOKI, query: '{service_name="demo-service"}', ...base, limit: 20 }, { fetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.length).toBeGreaterThan(0);
    for (let i = 1; i < r.data.length; i++) expect(BigInt(r.data[i - 1]!.tsNs) >= BigInt(r.data[i]!.tsNs)).toBe(true);
    expect(r.data.some((e) => e.metadata.severity_text !== undefined)).toBe(true);
    const c = calls[0]!;
    expect(c.url.pathname).toBe('/loki/api/v1/query_range');
    expect(c.headers['X-Loki-Response-Encoding-Flags']).toBe('categorize-labels');
    expect(c.url.searchParams.get('start')).toBe((BigInt(Date.parse(base.start)) * 1_000_000n).toString());
    expect(c.url.searchParams.get('limit')).toBe('20');
    expect(c.url.searchParams.get('direction')).toBe('backward');
  });

  it('loki matrix: parses log_volume fixture', async () => {
    const { fetch, calls } = replayFetch([loadFixtureText(sc, 'loki-volume.json')]);
    const r = await lokiQueryMatrix({ baseUrl: LOKI, query: 'q', ...base, stepS: 60 }, { fetch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((s) => s.metric.severity_text).sort()).toContain('error');
    expect(calls[0]!.url.searchParams.get('step')).toBe('60s');
  });
});

describe('transport behaviour', () => {
  const q = { baseUrl: PROM, query: 'x', start: '2026-11-16T18:00:00.000Z', end: '2026-11-16T18:05:00.000Z', stepS: 15 };

  it('retries once on a network error, then succeeds', async () => {
    const { fetch, calls } = replayFetch([new TypeError('fetch failed'), loadFixtureText('S1', 'prom-pool_max.json')]);
    const r = await promQueryRange(q, { fetch });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('gives up after exactly one retry and reports kind=network without the URL', async () => {
    const { fetch, calls } = replayFetch([new TypeError('fetch failed')]);
    const r = await promQueryRange(q, { fetch });
    expect(calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('network');
      expect(r.message).not.toContain('prom.test');
    }
  });

  it('does not retry an HTTP error response', async () => {
    const { fetch, calls } = replayFetch([{ status: 500, body: 'boom' }]);
    const r = await promQueryRange(q, { fetch });
    expect(calls).toHaveLength(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('http');
  });

  it('times out per attempt (retry once) with kind=timeout', async () => {
    let n = 0;
    const hang = ((_u: unknown, init?: RequestInit) => {
      n++;
      return new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }) as unknown as typeof fetch;
    const r = await promQueryRange(q, { fetch: hang, timeoutMs: 20 });
    expect(n).toBe(2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
  });

  it('an expired deadline sends nothing and is not retried', async () => {
    const { fetch, calls } = replayFetch([loadFixtureText('S1', 'prom-pool_used.json')]);
    const r = await promQueryRange(q, { fetch, deadline: Date.now() - 1 });
    expect(calls).toHaveLength(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
  });

  it('each attempt is capped by the time left before the deadline, and the retry is skipped once it passes', async () => {
    let n = 0;
    const hang = ((_u: unknown, init?: RequestInit) => {
      n++;
      return new Promise((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await promQueryRange(q, { fetch: hang, timeoutMs: 5_000, deadline: t0 + 60 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(n).toBe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('timeout');
  });

  it('a caller abort is never retried', async () => {
    const ac = new AbortController();
    let n = 0;
    const f = (async () => { n++; ac.abort(); throw new DOMException('aborted', 'AbortError'); }) as unknown as typeof fetch;
    const r = await promQueryRange(q, { fetch: f, signal: ac.signal });
    expect(n).toBe(1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('aborted');
  });

  it('a 2xx body that matches no schema is kind=parse', async () => {
    // Real captured matrix response relabelled as a resultType the client does not accept.
    const fx = loadFixture('S1', 'prom-pool_used.json') as any;
    const { fetch } = replayFetch([JSON.stringify({ ...fx, data: { ...fx.data, resultType: 'vector' } })]);
    const r = await promQueryRange(q, { fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('parse');
  });
});
