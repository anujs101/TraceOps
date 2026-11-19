import { renderPromql, type MetricName } from '@traceops/contracts';

export type MissingReason = 'empty' | 'nan' | 'error' | 'timeout' | 'ambiguous';
export type InstantResult = { kind: 'value'; value: number } | { kind: 'missing'; reason: MissingReason; detail?: string };

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Instant query (`/api/v1/query`) with the SAME template strings the tools use
 * (renderPromql). Anything that is not exactly one finite sample is "missing data":
 * the caller must make no state transition for it (detection.md §3).
 */
export async function queryInstant(
  prometheusUrl: string, query: MetricName, service: string, timeoutS: number,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
): Promise<InstantResult> {
  const url = `${prometheusUrl.replace(/\/+$/, '')}/api/v1/query?${new URLSearchParams({ query: renderPromql(query, service) })}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const res = await fetchFn(url, { signal: ctl.signal });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.status !== 'success') {
      return { kind: 'missing', reason: 'error', detail: String(body?.error ?? `http ${res.status}`).slice(0, 200) };
    }
    const result = body.data?.result;
    if (body.data?.resultType !== 'vector' || !Array.isArray(result)) return { kind: 'missing', reason: 'error', detail: 'unexpected resultType' };
    if (result.length === 0) return { kind: 'missing', reason: 'empty' };
    if (result.length > 1) return { kind: 'missing', reason: 'ambiguous', detail: `${result.length} series` };
    const value = Number(result[0]?.value?.[1]);
    if (!Number.isFinite(value)) return { kind: 'missing', reason: 'nan', detail: String(result[0]?.value?.[1]) };
    return { kind: 'value', value };
  } catch (e) {
    return ctl.signal.aborted
      ? { kind: 'missing', reason: 'timeout' }
      : { kind: 'missing', reason: 'error', detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
