# Contract: demo-service telemetry

**Status:** frozen v1 (2026-11-17) · **Owner:** demo-service session · **Consumers:** detector, investigator tools
**Executable source:** `packages/contracts/src/telemetry.ts` (names, templates, allowlist). Evidence: `docs/research/spike-observability.md`, `docs/research/pool-lab.md`.

## 1. Resource attributes (set in the preloaded OTel bootstrap)

| OTel attribute | Value | Prometheus label | Loki |
|---|---|---|---|
| `service.name` | `demo-service` | `service_name` (and `job`) | index label `service_name` |
| `service.version` | `1.0.0` baseline, `1.0.1` faulty "deploy" (env `SERVICE_VERSION`) | `service_version` | structured metadata `service_version` |
| `deployment.environment.name` | `local` | `deployment_environment_name` | index label |
| `service.instance.id` | auto (new on every restart) | `instance` | index label `service_instance_id` |

**Rule:** every query aggregates by `service_name`, never by `instance`, and never filters on `db_client_connection_pool_name`. Observed: `instrumentation-pg` labels the pool `unknown_host:unknown_port/unknown_database` when it's configured with a connection string, while our custom metrics use `main`.

## 2. Bootstrap rules (all observed failures in the spikes)
- Start the OTel SDK in a separate CommonJS file preloaded with `node --require`. Otherwise ESM import hoisting loads `http`, `express`, `pg` and `pino` first and **nothing gets instrumented, with no error**.
- Instrumentations: `http`, `express`, `pg`, `pino`, `runtime-node` (**default** `monitoringPrecision`; see §3).
- Metric export interval **5 s**. `BatchLogRecordProcessor({ exporter })` (options-object form in sdk-logs 3.x). `OTEL_SEMCONV_STABILITY_OPT_IN=http`.
- Custom histograms in seconds **must set `advice.explicitBucketBoundaries`**. The SDK defaults are millisecond-scale and would make a p95 in seconds meaningless. For acquire wait: `[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 5]`.

## 3. Metrics (Prometheus names as stored; all observed)

| Purpose | Prometheus name | Labels used by TraceOps | Single source |
|---|---|---|---|
| Request latency / rate / errors | `http_server_request_duration_seconds_{bucket,count,sum}` | `service_name`, `http_response_status_code`, `http_route` (observed: `/orders`, `/products`, `/healthz`) | instrumentation-http/express |
| Connections by state | `db_client_connection_count` | `service_name`, `db_client_connection_state` ∈ {`idle`,`used`} | **demo-service observable gauge** (`idleCount`, `totalCount − idleCount`) |
| Pool limit | `db_client_connection_max` | `service_name` | **demo-service observable gauge** (`options.max`) |
| Queued acquisitions | `db_client_connection_pending_requests` | `service_name` | **demo-service observable gauge** (`waitingCount`) |
| Acquire wait time | `db_client_connection_wait_time_seconds_{bucket,count,sum}` | `service_name` | **demo-service custom**: timed around `pool.connect()`, recorded on success **and** failure |
| Acquire timeouts | `db_client_connection_timeouts_total` | `service_name` | **demo-service custom**: +1 when `pool.connect()` rejects with `timeout exceeded when trying to connect` |
| Query duration | `db_client_operation_duration_seconds_{bucket,count,sum}` | `service_name` | **instrumentation-pg** |
| Event-loop delay p99 | `nodejs_eventloop_delay_p99_seconds` | `service_name` | runtime-node. **Values include the sampling resolution** (floor ≈ 0.01 s at the default 10 ms; observed 1.0 s floor at 1000 ms) |
| Event-loop utilisation | `nodejs_eventloop_utilization_ratio` | `service_name` | runtime-node |

**Single-source rule (decided by measurement):**
- `instrumentation-pg` 0.78 also emits `db.client.connection.count`, `.max` and `.pending_requests`, under the same names. Emitting ours as well would double-count in `sum()`.
- Its instruments are **UpDownCounters updated only on pool events** (connect, acquire, release, remove). Joining the wait queue isn't an event, and **a leaked pool stops producing events**. In S1, its `pending_requests` read **0 throughout**, while acquisitions timed out at up to 29/s.
- **Decision:** drop those three `instrumentation-pg` instruments with an SDK View:
  ```js
  { instrumentName: <name>, meterName: '@opentelemetry/instrumentation-pg', aggregation: { type: AggregationType.DROP } }
  ```
  The demo service emits them as **observable gauges read at every export**. It keeps `instrumentation-pg`'s `db.client.operation.duration`.

### Gauges and staleness (verified)
With OTLP push, Prometheus keeps a dead instance's last gauge sample visible for the 5-min lookback. Observed 20 s after a restart: `count(db_client_connection_count{state="idle"})` = 2 series (old and new instance), `sum` = 3 (phantom). With `last_over_time(...[15s])`: 1 series, the correct value. **All gauge templates wrap `last_over_time(<gauge>[15s])`.** Consequence: if exports stop for more than 15 s, gauges read **empty**. That is reported as `status: "empty"`, never as 0.

## 4. Logs (pino → OTLP → Loki)

The log **line is pino's `msg` only**. Fields become structured metadata, and Loki stores **every metadata value as a string**.

| Loki metadata | Emitted as (pino) | Values observed |
|---|---|---|
| line | `msg` | fixed, low-cardinality phrases: `request completed`, `request failed`, `order rejected`, `service started` |
| `severity_text` | pino level | `info`, `warn`, `error` (lowercase) |
| `exception_type`, `exception_message` | `err` | e.g. `timeout exceeded when trying to connect` (from pg-pool) |
| `route`, `status`, `duration_ms` | same-named fields | `status` and `duration_ms` arrive as strings |
| `service_version` | resource | `1.0.0`, `1.0.1` |

**Required logging behaviour**
- Every completed request with status < 500 → `info` `request completed` {route, status, duration_ms}.
- Insufficient stock → `warn` `order rejected` {route, status: 409}.
- **Any error reaching the Express error handler, including pool-acquire timeouts → HTTP 500 and `error` `request failed` {err, route, status: 500}.** The `err` object must be passed as `err` so the instrumentation maps it to `exception_*`. No custom 503 and no swallowed errors.

**Ground-truth hygiene:** the app never logs phrases that name the cause (`FORBIDDEN_LOG_PHRASES` in the package: leak, pool exhausted, not released). Error text comes only from libraries.

**Never forwarded to the model or stored as evidence:** every field outside the allowlist in `tools.md` §4. That includes `process_command_args`, `process_owner`, `host_id`, `host_name`, `process_executable_path` and **`exception_stacktrace`** (observed: absolute file paths, including the OS username). All observed present.

## 5. Demo service surface

| Endpoint | Behaviour |
|---|---|
| `GET /products` | 1 query (with `FAULT=cpu_burn`: synchronous `pbkdf2Sync` first) |
| `POST /orders` | acquire → stock check → if insufficient: 409 + `order rejected` (with `FAULT=pool_leak`: **no `release()`**) → else transaction insert → release |
| `GET /healthz` | no DB access |

**Pool config:** `max: 10`, `connectionTimeoutMillis: 2000` (never 0), `idleTimeoutMillis: 30000`.
**Fault flag** (env `FAULT`, read at startup, which simulates a deploy): `none` | `pool_leak` | `cpu_burn` (+ `CPU_ITER`). See `scenario-db-pool.md`.
