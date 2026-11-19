# apps/demo-service — rules for this workspace

Everything here implements `docs/contracts/telemetry.md` and `scenario-db-pool.md` exactly. Each rule below is a failure observed in the spikes (`docs/research/`).

- **Compile to CommonJS and preload OTel with `node --require ./dist/otel.cjs`** (or equivalent). With ESM, `http`, `express`, `pg` and `pino` load before the SDK and nothing is instrumented, with no error.
- Instrumentations: `http`, `express`, `pg`, `pino`, `runtime-node` with the **default** `monitoringPrecision` (1000 ms adds a 1 s floor to event-loop delay).
- Metric export interval 5 s. Logs: `new BatchLogRecordProcessor({ exporter })` (sdk-logs 3.x options form). `OTEL_SEMCONV_STABILITY_OPT_IN=http`.
- **Drop instrumentation-pg's pool gauges with a View** (`meterName: '@opentelemetry/instrumentation-pg'`, `AggregationType.DROP`) for `db.client.connection.count`, `.max`, `.pending_requests`. Emit our own **observable gauges read at export** from `pool.totalCount/idleCount/waitingCount/options.max`. Theirs go stale under a leak.
- Custom histograms in seconds **must** set `advice.explicitBucketBoundaries` (acquire wait: `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 5]`).
- Acquire timeout → HTTP **500** + `error` log `request failed` with the error passed as `err`. No custom 503, no swallowed errors.
- **Never log phrases that name the cause** (`FORBIDDEN_LOG_PHRASES`: leak, pool exhausted, not released). Error text comes from libraries only.
- Pool: `max: 10`, `connectionTimeoutMillis: 2000`, `idleTimeoutMillis: 30000`.
- `spike/pool-lab/` is a reference for what worked, not code to copy blindly or import.
