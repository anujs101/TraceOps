import { describe, expect, it } from 'vitest';
import { renderPromql } from '@traceops/contracts';
import { queryInstant } from '../../src/detector/prom-client.ts';
import { FixtureProm, sampleValue, type Mode } from './fixture-prom.ts';

const URL_ = 'http://prom.test/';

describe('queryInstant (fixture-backed Prometheus)', () => {
  it.each(['latency_p95', 'error_ratio_5xx'] as const)('%s: GET /api/v1/query with the shared template string', async (m) => {
    const prom = new FixtureProm();
    prom.set('breach', 'breach');
    await queryInstant(URL_, m, 'demo-service', 5, prom.fetch);
    const u = new URL(prom.requests[0]!);
    expect(u.origin + u.pathname).toBe('http://prom.test/api/v1/query');
    expect(u.searchParams.get('query')).toBe(renderPromql(m, 'demo-service'));
    expect([...u.searchParams.keys()]).toEqual(['query']); // instant: no start/end/step
  });

  it.each([
    ['latency_p95', 'breach', 2.425], ['latency_p95', 'ok', sampleValue('latency_p95', 'ok')],
    ['error_ratio_5xx', 'breach', 1], ['error_ratio_5xx', 'ok', sampleValue('error_ratio_5xx', 'ok')],
  ] as const)('%s / %s → the fixture value', async (m, mode, value) => {
    const prom = new FixtureProm();
    prom.set(mode, mode);
    expect(await queryInstant(URL_, m, 'demo-service', 5, prom.fetch)).toEqual({ kind: 'value', value });
  });

  it.each([
    ['empty', 'empty'], ['nan', 'nan'], ['badquery', 'error'], ['http500', 'error'],
  ] as [Mode, string][])('%s → missing(%s), never a value', async (mode, reason) => {
    const prom = new FixtureProm();
    prom.set(mode, mode);
    expect(await queryInstant(URL_, 'latency_p95', 'demo-service', 5, prom.fetch)).toMatchObject({ kind: 'missing', reason });
  });

  it('a hung backend is aborted at query_timeout_s → missing(timeout)', async () => {
    const prom = new FixtureProm();
    prom.set('hang', 'hang');
    const t0 = Date.now();
    expect(await queryInstant(URL_, 'latency_p95', 'demo-service', 0.05, prom.fetch)).toEqual({ kind: 'missing', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a network failure is missing(error)', async () => {
    const r = await queryInstant(URL_, 'latency_p95', 'demo-service', 5, async () => { throw new Error('ECONNREFUSED'); });
    expect(r).toEqual({ kind: 'missing', reason: 'error', detail: 'ECONNREFUSED' });
  });

  it('more than one series is ambiguous, not a guess', async () => {
    const one = new FixtureProm();
    one.set('breach', 'breach');
    const body: any = await (await one.fetch('http://x/?query=' + encodeURIComponent(renderPromql('latency_p95', 'demo-service')))).json();
    body.data.result.push(body.data.result[0]);
    const r = await queryInstant(URL_, 'latency_p95', 'demo-service', 5, async () => ({ ok: true, status: 200, json: async () => body }));
    expect(r).toMatchObject({ kind: 'missing', reason: 'ambiguous' });
  });
});
