# Spike: observability stack — observed names, labels and pitfalls

**Date:** 2026-11-16 · **Branch:** `spike/observability` · **Code:** `spike/`
**Goal:** freeze the telemetry contract from what the backends actually store, not from guesses.

## Setup that was tested
- `grafana/otel-lgtm:0.40.0` via `spike/docker-compose.yml`, `mem_limit: 2g`.
- Toy Node 24 emitter: `node --require ./otel.cjs emit.cjs` (OTel JS SDK `sdk-node 0.301.2`, `sdk-metrics/sdk-logs 3.1.1`, `instrumentation-http 0.301.2`, `instrumentation-pino 0.71.0`, `pino 10.4.0`).
- `OTEL_SEMCONV_STABILITY_OPT_IN=http`, metric export interval 5 s.
- Queried from the host with `spike/probe.sh` (Prometheus `:9090`, Loki `:3100`).

## Results

| Question | Observed | Contract impact |
|---|---|---|
| Is Loki API reachable from host? | Yes, **after we publish 3100 ourselves** (upstream run script does not). `/ready` → `ready` | Compose must publish 3100 |
| Container footprint | ~920 MiB RSS idle; ~2 min to ready on first start | Fits, but budget it on the 8 GB machine |
| Custom pool metric names | Exactly as predicted: `db_client_connection_count{db_client_connection_state=idle\|used}`, `db_client_connection_max`, `db_client_connection_pending_requests`, `db_client_connection_timeouts_total`, `db_client_connection_wait_time_seconds_{bucket,count,sum}` | Freeze these names. `{connection}`-style units are dropped; `s` → `_seconds`; counters get `_total` |
| HTTP server metric | `http_server_request_duration_seconds_*` with `http_request_method`, `http_response_status_code`, `error_type` | Freeze. **No `http_route` label** with plain `node:http` — the real app needs Express instrumentation; verify the label then |
| Resource attributes on metrics | otel-lgtm promotes them onto **every series**: `service_name`, `service_version`, `deployment_environment_name`, `host_name`, plus `job`=`service.name`, `instance`=`service.instance.id` | `service_version` on metrics gives deploy correlation for free. Each restart = new `instance` → **always aggregate by `service_name`**, never by instance |
| PromQL p95 | `histogram_quantile(0.95, sum by (le) (rate(..._bucket[1m])))` returned a value | Template works |
| Loki stream labels (indexed) | `service_name`, `service_instance_id`, `deployment_environment_name` | Stream selector: `{service_name="…"}` |
| Loki log line | **Only pino's `msg`** (e.g. `request failed`) | Line filters (`\|=`) only search the message — not error text |
| Where the error text lives | Structured metadata: `exception_message`, `exception_type`; level in `severity_text` (lowercase) / `severity_number`; pino fields (`route`, `status`, `duration_ms`) also as metadata | Log tools filter with `\| severity_text="error"` and `\| exception_message=~"…"`; tested: `count_over_time({service_name=…} \| severity_text="error" [15m])` works |
| What else is in metadata | `process_command`, `process_command_args`, `process_owner`, `host_id`, `host_name`, `process_executable_path` … | **Security:** command args can contain secrets. The log adapter must pass the model an **allowlist** of fields (message, severity, exception_*, route, status, duration_ms, service_version, timestamp), never the raw metadata |

## Pitfalls hit (and fixes) — keep for the build sessions
1. **ESM import hoisting.** Starting the SDK inside an `.mjs` app patched nothing: `http` and `pino` were already loaded. HTTP metrics and all OTLP logs were silently missing. **Fix:** start the SDK in a separate file preloaded with `node --require ./otel.cjs` (or the ESM `--import` hook). The demo service must do this.
2. **`BatchLogRecordProcessor` API changed in sdk-logs 3.x:** takes `{ exporter }`, not a positional exporter. Positional form crashes on shutdown (`Cannot read properties of undefined (reading 'shutdown')`).
3. Default metric export interval is 60 s; we set 5 s. Detection latency depends on this.

## Still unverified (check when the real demo service exists)
- `http_route` label via Express instrumentation.
- Whether `@opentelemetry/instrumentation-pg` already emits any pool metrics (avoid duplicates with our custom ones).
- Event-loop delay metric name (needed for the negative control).
- Ingestion lag Loki/Prometheus under load (seconds here, not measured precisely).
