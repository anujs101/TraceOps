import { PromErrorResponse, PromRangeResponse } from '@traceops/contracts';
import { fail, getJson, type BackendDeps, type BackendResult } from './http.ts';

export type PromSeries = { metric: Record<string, string>; values: [number, string][] };

export type PromRangeQuery = {
  baseUrl: string;
  query: string;
  /** IsoUtcMs */
  start: string;
  end: string;
  stepS: number;
};

/** GET {prometheus}/api/v1/query_range → the parsed matrix. Never throws. */
export async function promQueryRange(q: PromRangeQuery, deps: BackendDeps = {}): Promise<BackendResult<PromSeries[]>> {
  const url = new URL('/api/v1/query_range', q.baseUrl);
  url.searchParams.set('query', q.query);
  url.searchParams.set('start', q.start);
  url.searchParams.set('end', q.end);
  url.searchParams.set('step', `${q.stepS}s`);

  const raw = await getJson(url, { accept: 'application/json' }, deps);
  if (!raw.ok) return fail(raw.kind, `prometheus ${raw.message}`);

  const success = PromRangeResponse.safeParse(raw.body);
  if (success.success) return { ok: true, data: success.data.data.result };

  const err = PromErrorResponse.safeParse(raw.body);
  if (err.success) return fail('backend', `prometheus ${err.data.errorType}: ${err.data.error}`);

  return fail(raw.body === undefined ? 'http' : 'parse', `prometheus returned an unexpected response (HTTP ${raw.status})`);
}
