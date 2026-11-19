import { LIMITS } from '@traceops/contracts';

/** Injectable so tests replay fixtures instead of touching a network. */
export type FetchFn = typeof fetch;

export type BackendDeps = {
  fetch?: FetchFn;
  /** Per-attempt timeout; default LIMITS.backendTimeoutMs (tools.md §1). */
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * kind tells the caller what went wrong without exposing URLs or queries:
 *  network  fetch rejected (after one retry), timeout  per-attempt timeout (after one retry),
 *  aborted  the caller's signal fired (never retried), http  non-JSON or unexpected HTTP body,
 *  backend  Prometheus/Loki answered with its own error, parse  2xx body did not match the schema.
 */
export type BackendErrorKind = 'network' | 'timeout' | 'aborted' | 'http' | 'backend' | 'parse';
export type BackendResult<T> = { ok: true; data: T } | { ok: false; kind: BackendErrorKind; message: string };

export const fail = <K extends BackendErrorKind>(kind: K, message: string): { ok: false; kind: K; message: string } => ({ ok: false, kind, message });

type Raw = { ok: true; status: number; body: unknown } | { ok: false; kind: 'network' | 'timeout' | 'aborted'; message: string };

/**
 * GET a URL and parse the body as JSON. One retry, only when the request itself
 * failed (fetch rejected or timed out). Any HTTP response, including 4xx/5xx, is
 * returned as-is: Prometheus reports query errors as a JSON body on HTTP 400.
 */
export async function getJson(url: URL, headers: Record<string, string>, deps: BackendDeps): Promise<Raw> {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? LIMITS.backendTimeoutMs;
  let last: Raw = { ok: false, kind: 'network', message: 'request failed' };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (deps.signal?.aborted) return { ok: false, kind: 'aborted', message: 'aborted' };
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout;
    try {
      const res = await doFetch(url, { method: 'GET', headers, signal });
      const text = await res.text();
      try {
        return { ok: true, status: res.status, body: JSON.parse(text) };
      } catch {
        return { ok: true, status: res.status, body: undefined }; // not JSON; caller reports kind 'http'
      }
    } catch (e) {
      if (deps.signal?.aborted) return { ok: false, kind: 'aborted', message: 'aborted' };
      last = timeout.aborted
        ? { ok: false, kind: 'timeout', message: `timed out after ${timeoutMs} ms` }
        : { ok: false, kind: 'network', message: e instanceof Error ? e.message.slice(0, 120) : 'request failed' };
    }
  }
  return last;
}
