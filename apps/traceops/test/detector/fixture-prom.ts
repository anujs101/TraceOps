import { readFileSync } from 'node:fs';
import { renderPromql, type MetricName } from '@traceops/contracts';
import type { FetchLike } from '../../src/detector/prom-client.ts';

/**
 * A Prometheus whose every answer is derived from the real captured fixtures in
 * packages/contracts/fixtures/ (never hand-written). The fixtures are range
 * (matrix) captures; an instant query returns one sample of the same series, so a
 * vector response is built from a real point of the matrix.
 */
const FIXTURES = new URL('../../../../packages/contracts/fixtures/', import.meta.url);
const load = (scenario: 'S1' | 'S2', name: string): any => JSON.parse(readFileSync(new URL(`${scenario}/prom-${name}.json`, FIXTURES), 'utf8'));

type Pick = 'min' | 'max' | 'first' | 'last';
function point(matrix: any, pick: Pick): [number, string] {
  const values: [number, string][] = matrix.data.result[0].values;
  if (pick === 'first') return values[0]!;
  if (pick === 'last') return values.at(-1)!;
  return values.reduce((a, b) => ((+b[1] > +a[1]) === (pick === 'max') ? b : a));
}
const vector = (p: [number, string] | null) => ({
  status: 'success', data: { resultType: 'vector', result: p ? [{ metric: {}, value: p }] : [] },
});

export type Mode = 'breach' | 'ok' | 'empty' | 'nan' | 'badquery' | 'http500' | 'hang';

/** Sample picked per metric and mode, with the fixture it comes from. Thresholds: latency > 1.0, error ratio > 0.05. */
const SOURCE: Record<MetricName & ('latency_p95' | 'error_ratio_5xx'), Record<'breach' | 'ok', () => [number, string]>> = {
  latency_p95: { breach: () => point(load('S1', 'latency_p95'), 'max'), ok: () => point(load('S1', 'latency_p95'), 'min') },
  error_ratio_5xx: { breach: () => point(load('S1', 'error_ratio_5xx'), 'last'), ok: () => point(load('S2', 'error_ratio_5xx'), 'last') },
};

export const sampleValue = (m: 'latency_p95' | 'error_ratio_5xx', k: 'breach' | 'ok'): number => Number(SOURCE[m][k]()[1]);

export class FixtureProm {
  script: Record<'latency_p95' | 'error_ratio_5xx', Mode> = { latency_p95: 'ok', error_ratio_5xx: 'ok' };
  readonly requests: string[] = [];

  set(latency: Mode, error: Mode) { this.script = { latency_p95: latency, error_ratio_5xx: error }; }

  fetch: FetchLike = async (url, init) => {
    this.requests.push(url);
    const q = new URL(url).searchParams.get('query');
    const metric = (['latency_p95', 'error_ratio_5xx'] as const).find((m) => q === renderPromql(m, 'demo-service'));
    if (!metric) throw new Error(`unexpected query ${q}`);
    const mode = this.script[metric];
    const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    switch (mode) {
      case 'breach': case 'ok': return json(vector(SOURCE[metric][mode]()));
      case 'empty': return json({ ...load('S1', 'empty'), data: { resultType: 'vector', result: load('S1', 'empty').data.result } });
      case 'nan': return json(vector([SOURCE[metric].ok()[0], 'NaN']));
      case 'badquery': return json(load('S1', 'error-badquery'), 400);
      case 'http500': return json({ status: 'error', error: 'internal' }, 500);
      case 'hang':
        return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
  };
}
