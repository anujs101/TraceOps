# Pool lab: verifying contract assumptions with a real pg pool

**Date:** 2026-11-16 · **Branch:** `design/contracts` · **Code:** `spike/pool-lab/` (throwaway; not the demo-service)
**Setup:** Express 5.3 + pg 8.23 (pool `max 10`, `connectionTimeoutMillis 2000`), OTel instrumentations http/express/pg 0.78/pino/runtime-node 0.38, `grafana/otel-lgtm:0.40.0`, Postgres 18, open-loop load 30 rps (80% `GET /products`, 20% `POST /orders`), all on the M2 / 8 GB laptop.

## 1. Naming questions (resolved)
| Question | Result |
|---|---|
| `http_route` with Express instrumentation | present: `/orders`, `/products`, `/healthz` |
| pino `warn` → `severity_text` | `warn` (lowercase; `detected_level` also `warn`) |
| Event-loop metric names | `nodejs_eventloop_delay_{min,max,mean,p50,p90,p99,stddev}_seconds`, `nodejs_eventloop_utilization_ratio`, `nodejs_eventloop_time_seconds_total` |
| Event-loop delay floor | **values include the sampling resolution**: with `monitoringPrecision: 1000` the minimum read 1.0003 s at idle. Use the default 10 ms (floor ≈ 0.012 s observed) |
| Does `instrumentation-pg` emit pool metrics? | **yes**, `db.client.connection.count/max/pending_requests` (same names as ours) + `db.client.operation.duration`. Pool name label is `unknown_host:unknown_port/unknown_database` with a connection string |

## 2. `instrumentation-pg` pool gauges go stale under a leak
Its pool instruments are UpDownCounters updated only on pool events (`connect`, `acquire`, `release`, `remove`; see `utils.cjs updateCounter`). In the first S1 run, **`pending_requests` read 0 for the whole incident** while acquisitions timed out at 4–29/s, each having waited 2 s in the queue. Joining the queue emits no event, and a fully leaked pool emits none at all.
**Decision:** drop those three instruments via an SDK View (`AggregationType.DROP`, `meterName: '@opentelemetry/instrumentation-pg'`), and emit observable gauges read from `pool.totalCount/idleCount/waitingCount` at every export. Re-verified in the S1 rerun (§5).

## 3. Gauge staleness after restart (verified)
20 s after restarting the service (new `instance`):
| Query | Result |
|---|---|
| `count(db_client_connection_count{state="idle"})` | **2** series (dead instance still visible) |
| `sum(db_client_connection_count{state="idle"})` | **3** (phantom from the dead instance) |
| `count(last_over_time(…[15s]))` | 1 |
| `sum(last_over_time(…[15s]))` | 0 (correct for the live, leaking instance) |

`last_over_time(<gauge>[15s])` is required.

## 4. S2: a CPU fault exhausts the pool too (rc1 assumption falsified)
`pbkdf2Sync` cost: ≈ 0.11 ms per 1000 iterations. Each row covers a 100 s window.

| Variant | p95 latency | 5xx | used max | pending max | acquire timeouts | EL util | EL p99 | query p95 |
|---|---|---|---|---|---|---|---|---|
| burn 300k iter (~33 ms) | 2.15 s | 0.7% | 10 | 14 | 5 | 1.0 | 1.97 s* | 0.78 s |
| burn 380k iter (~42 ms) | 4.02 s | 21% | 10 | 54 | 343 | 1.0 | 1.57 s* | 0.50 s |
| 3% of requests block 6M iter (~0.66 s) | 2.39 s | 9.4% | 10 | 57 | 132 | 1.0 | 2.90 s | 0.85 s |
| 4% of requests block 9M iter (~1 s) | 4.01 s | 39% | 10 | 51 | 419 | 1.0 | 3.15 s | 4.01 s |

\* These two runs used `monitoringPrecision: 1000`, so their EL delay values include a ≈ 1 s floor.
Pool numbers in this table came from the event-driven `instrumentation-pg` gauges (before §2's fix). They're still valid while the pool keeps cycling, because events keep flowing.

**Conclusion:** at this load, every CPU fault strong enough to breach the 1 s p95 alert saturates the event loop. Connections are then held across delayed callbacks, the pool hits `max`, and real acquire timeouts follow. S2 is redefined as a cause-vs-effect scenario (`scenario-db-pool.md`).

## 5. S1 (leak), end to end
First run (event-driven pg gauges), windows: baseline 18:15:04–18:17:05Z, after deploy –18:20:13Z, low load –18:22:04Z.

| Phase | p95 latency | 5xx | used | idle | pending | wait p95 | timeouts/s | query p95 | EL util | EL p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | ≤ 0.048 s | 0 | 1 | 3–9 | 0 | ≤ 2 ms | 0 | ≤ 32 ms | ≤ 0.26 | ≤ 0.040 s |
| after deploy | → 2.43 s | → 100% | → 10 | → 0 | 0 (stale!) | → 2.47 s | 4–29 | ≤ 36 ms | ≤ 0.27 | ≤ 0.035 s |
| load at 20% | 2.42 s | 100% | **10** | 0 | 0 (stale!) | 2.47 s | 5–28 | — | ≤ 0.16 | ≤ 0.068 s |

The pool never recovered (a leak, not overload). The event loop and DB stayed healthy, which is the opposite of S2.

## 6. Reruns with export-time pool gauges (fixtures captured from these)
**View check:** in the rerun window, only our gauge (`pool_name="main"`) exists; `instrumentation-pg`'s pool series are gone.

**S1 rerun** (18:23:38–18:30:39Z):
| phase | p95 | 5xx | used | idle | pending | wait p95 | timeouts/s | query p95 | EL util | EL p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 0.012–0.125 | — | 0–1 | 2–10 | 0 | ≤ 4 ms | — | ≤ 44 ms | ≤ 0.35 | ≤ 0.059 |
| after deploy | → 2.42 | 0.35–1 | → 10 | → 0 | **0–62** | → 2.47 | 10–29 | ≤ 5 ms | ≤ 0.21 | ≤ 0.033 |
| load 20% | 2.42 | 1 | **10** | 0 | 0–12 | 2.47 | 5–29 | — | ≤ 0.07 | ≤ 0.017 |

**S2 run** (CPU_ITER=300000; steady state from deploy+60 s):
| phase | p95 | 5xx | used | idle | pending | wait p95 | timeouts | query p95 | EL util | EL p99 |
|---|---|---|---|---|---|---|---|---|---|---|
| after deploy | 2.35–2.43 | — | **10** | 0 | **17–21** | 0.99–1.41 | **0** | **0.50–0.68** | **1.0** | 0.40–0.88 |
| load 20% | 0.97–2.37 | 1.6–1.8% | **0–3** | 3–9 | 0 | ≤ 1.28 | 0 | 0.46–0.51 | ≤ 1.0 | ≤ 0.51 |

S2's "baseline" (not shown) was contaminated by the S1 run that ended 27 s earlier → the cool-down rule and the `baseline_clean` validity check.
Load-generator note: in S2 the client saw 1,318 of 6,046 requests time out at 5 s (open loop vs a saturated server); the server's histogram still records them when they complete.

## VERIFY: still open
1. **Live structured-output call.** The report and tool schemas pass the offline check against the documented limits, but no API call has been made (no `ANTHROPIC_API_KEY` on this machine). Needs one real request with `output_config.format` = `toApiJsonSchema(ReportApi)` and the four strict tools.
2. **S2 stability on the recording day.** S2 sits at CPU saturation, so screen recording will shift it. Retune `CPU_ITER` and rely on the validity gate.
3. **Detector timing under S2.** Only the latency rule fires in S2 (5xx ≈ 0). Expected to fire, since p95 ≥ 2.35 s for minutes, but not yet exercised by a detector implementation.
4. **Redaction patterns** (tokens, emails, connection strings) are specified but have no test corpus yet; the demo app emits none of them, so fixtures can't exercise them.
