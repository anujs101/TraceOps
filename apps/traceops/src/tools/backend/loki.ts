import { LokiMatrixResponse, LokiStreamsResponse } from '@traceops/contracts';
import { fail, getJson, type BackendDeps, type BackendResult } from './http.ts';

export type LokiEntry = { tsNs: string; line: string; metadata: Record<string, string> };
export type LokiMatrixSeries = { metric: Record<string, string>; values: [number, string][] };

type Base = { baseUrl: string; query: string; start: string; end: string };

const msToNs = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

// Loki wraps its own errors as plain text, so a non-JSON body is the usual error shape.
function unexpected(status: number, body: unknown): { ok: false; kind: 'http' | 'parse'; message: string } {
  return fail(body === undefined ? 'http' : 'parse', `loki returned an unexpected response (HTTP ${status})`);
}

/**
 * GET {loki}/loki/api/v1/query_range for a log query. Entries are flattened across
 * streams and sorted newest first. `categorize-labels` puts the structured metadata
 * in each entry's third element, which is where our allowlisted fields live.
 */
export async function lokiQueryLogs(q: Base & { limit: number }, deps: BackendDeps = {}): Promise<BackendResult<LokiEntry[]>> {
  const url = new URL('/loki/api/v1/query_range', q.baseUrl);
  url.searchParams.set('query', q.query);
  url.searchParams.set('start', msToNs(q.start));
  url.searchParams.set('end', msToNs(q.end));
  url.searchParams.set('limit', String(q.limit));
  url.searchParams.set('direction', 'backward');

  const raw = await getJson(url, { accept: 'application/json', 'X-Loki-Response-Encoding-Flags': 'categorize-labels' }, deps);
  if (!raw.ok) return fail(raw.kind, `loki ${raw.message}`);

  const parsed = LokiStreamsResponse.safeParse(raw.body);
  if (!parsed.success) return unexpected(raw.status, raw.body);

  const entries: LokiEntry[] = [];
  for (const stream of parsed.data.data.result) {
    for (const [tsNs, line, meta] of stream.values) {
      entries.push({ tsNs, line, metadata: { ...stream.stream, ...meta?.structuredMetadata, ...meta?.parsed } });
    }
  }
  entries.sort((a, b) => (BigInt(a.tsNs) < BigInt(b.tsNs) ? 1 : BigInt(a.tsNs) > BigInt(b.tsNs) ? -1 : 0));
  return { ok: true, data: entries };
}

/** GET {loki}/loki/api/v1/query_range for a metric query (count_over_time …). */
export async function lokiQueryMatrix(q: Base & { stepS: number }, deps: BackendDeps = {}): Promise<BackendResult<LokiMatrixSeries[]>> {
  const url = new URL('/loki/api/v1/query_range', q.baseUrl);
  url.searchParams.set('query', q.query);
  url.searchParams.set('start', msToNs(q.start));
  url.searchParams.set('end', msToNs(q.end));
  url.searchParams.set('step', `${q.stepS}s`);

  const raw = await getJson(url, { accept: 'application/json' }, deps);
  if (!raw.ok) return fail(raw.kind, `loki ${raw.message}`);

  const parsed = LokiMatrixResponse.safeParse(raw.body);
  if (!parsed.success) return unexpected(raw.status, raw.body);
  return { ok: true, data: parsed.data.data.result };
}
