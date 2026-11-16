/** Shared local environment (docs/contracts/environment.md). One source for ports. */
export const PORTS = {
  grafana: 3000,
  loki: 3100,
  otlpHttp: 4318,
  prometheus: 9090,
  postgres: 5432, // one container, databases `demo` and `traceops`
  demoService: 8080,
  traceopsApi: 4000,
  traceopsUi: 5173,
} as const;

export const DATABASES = { demo: 'demo', traceops: 'traceops' } as const;

export const POOL_CONFIG = { max: 10, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000 } as const;
export const METRIC_EXPORT_INTERVAL_MS = 5000;
