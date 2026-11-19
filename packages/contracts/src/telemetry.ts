/**
 * Telemetry contract (docs/contracts/telemetry.md). Names are as stored in
 * Prometheus/Loki, observed in docs/research/spike-observability.md and
 * docs/research/pool-lab.md.
 */
export const SERVICE = 'demo-service' as const;

export const METRICS = {
  httpDuration: 'http_server_request_duration_seconds',
  poolCount: 'db_client_connection_count', // source: demo-service observable gauge (instrumentation-pg's is dropped: stale under leak)
  poolMax: 'db_client_connection_max', // source: demo-service observable gauge
  poolPending: 'db_client_connection_pending_requests', // source: demo-service observable gauge (pool.waitingCount at export)
  poolWait: 'db_client_connection_wait_time_seconds', // source: demo-service custom
  poolTimeouts: 'db_client_connection_timeouts_total', // source: demo-service custom
  dbOperation: 'db_client_operation_duration_seconds', // source: instrumentation-pg
  eventLoopDelayP99: 'nodejs_eventloop_delay_p99_seconds', // source: runtime-node
  eventLoopUtilization: 'nodejs_eventloop_utilization_ratio', // source: runtime-node
} as const;

/** Model-facing metric names → server-side PromQL. `$svc` is bound from the incident. */
export const METRIC_TEMPLATES = {
  latency_p95: { unit: 's', promql: `histogram_quantile(0.95, sum by (le) (rate(${METRICS.httpDuration}_bucket{service_name="$svc"}[1m])))` },
  latency_p50: { unit: 's', promql: `histogram_quantile(0.5, sum by (le) (rate(${METRICS.httpDuration}_bucket{service_name="$svc"}[1m])))` },
  request_rate: { unit: 'req/s', promql: `sum(rate(${METRICS.httpDuration}_count{service_name="$svc"}[1m]))` },
  error_ratio_5xx: {
    unit: 'ratio',
    // v1.3: `or vector(0)` on the numerator only. With traffic and no 5xx the ratio is 0 (not empty), so the
    // rule can return to ok and the group can resolve. With no traffic the denominator is empty and the result
    // stays empty (missing data). docs/proposals/detection-error-ratio-empty.md
    promql: `(sum(rate(${METRICS.httpDuration}_count{service_name="$svc",http_response_status_code=~"5.."}[1m])) or vector(0)) / sum(rate(${METRICS.httpDuration}_count{service_name="$svc"}[1m]))`,
  },
  pool_used: { unit: 'connections', promql: `sum(last_over_time(${METRICS.poolCount}{service_name="$svc",db_client_connection_state="used"}[15s]))` },
  pool_idle: { unit: 'connections', promql: `sum(last_over_time(${METRICS.poolCount}{service_name="$svc",db_client_connection_state="idle"}[15s]))` },
  pool_max: { unit: 'connections', promql: `max(last_over_time(${METRICS.poolMax}{service_name="$svc"}[15s]))` },
  pool_pending: { unit: 'requests', promql: `sum(last_over_time(${METRICS.poolPending}{service_name="$svc"}[15s]))` },
  pool_wait_p95: { unit: 's', promql: `histogram_quantile(0.95, sum by (le) (rate(${METRICS.poolWait}_bucket{service_name="$svc"}[1m])))` },
  pool_timeout_rate: { unit: 'timeouts/s', promql: `sum(rate(${METRICS.poolTimeouts}{service_name="$svc"}[1m]))` },
  db_operation_p95: { unit: 's', promql: `histogram_quantile(0.95, sum by (le) (rate(${METRICS.dbOperation}_bucket{service_name="$svc"}[1m])))` },
  eventloop_delay_p99: { unit: 's', promql: `max(last_over_time(${METRICS.eventLoopDelayP99}{service_name="$svc"}[15s]))` },
  eventloop_utilization: { unit: 'ratio', promql: `max(last_over_time(${METRICS.eventLoopUtilization}{service_name="$svc"}[15s]))` },
} as const;
export type MetricName = keyof typeof METRIC_TEMPLATES;
export const METRIC_NAMES = Object.keys(METRIC_TEMPLATES) as [MetricName, ...MetricName[]];

export function renderPromql(metric: MetricName, service: string): string {
  if (!/^[a-z0-9-]+$/.test(service)) throw new Error('invalid service name');
  return METRIC_TEMPLATES[metric].promql.replaceAll('$svc', service);
}

/** Loki structured-metadata fields that may reach the model or the evidence store. */
export const LOG_ALLOWED_FIELDS = [
  'timestamp', 'message', 'severity_text', 'exception_type', 'exception_message',
  'route', 'status', 'duration_ms', 'service_version',
] as const;
export const SEVERITIES = ['error', 'warn', 'info'] as const; // observed severity_text values

/** Phrases the demo service must never log (ground-truth hygiene). */
export const FORBIDDEN_LOG_PHRASES = [/leak/i, /pool exhaust/i, /not released/i, /forgot to release/i];
