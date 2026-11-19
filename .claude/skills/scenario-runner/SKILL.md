---
name: scenario-runner
description: How to run TraceOps evaluation scenarios S1 (pool leak) or S2 (CPU burn) correctly on the live stack, including baseline, fault restart, load profile, cool-down and the validity gate. Use whenever a task involves running, re-running or checking a live scenario.
---
# Running a scenario (scenario-db-pool.md)

## Preconditions
1. Docker is running and `docker compose -f infra/compose.yml ps` shows otel-lgtm and postgres up. otel-lgtm needs about 2 minutes from a cold start; wait for `curl -s localhost:9090/-/ready` and `curl -s localhost:3100/ready`.
2. No `spike-*` containers on the same ports (`docker ps`).
3. **Cool-down:** the last scenario on `service_name="demo-service"` ended at least 5 minutes ago. Otherwise the baseline is contaminated through `rate(...[1m])` and the gauge lookback (measured). Wait; don't skip.
4. Recording or other heavy apps running? Note it: S2 is sensitive to CPU load.

## Timeline (both scenarios)
1. Start demo-service with `FAULT=none SERVICE_VERSION=1.0.0`; load at 30 rps (80% `GET /products`, 20% `POST /orders`, `LOW_STOCK_SHARE=0.02`) for **≥ 90 s**.
2. Restart ("deploy") with `SERVICE_VERSION=1.0.1` and `FAULT=pool_leak` (S1) or `FAULT=cpu_burn CPU_ITER=400000` (S2, contracts v1.4). Keep the load running.
3. Keep the load until the incident is detected, **plus 3 minutes**.
4. Drop to **6 rps for ≥ 60 s** (this is what separates S1, no recovery, from S2, recovery).
5. Stop the load; record the end time.

Use `apps/demo-service/scripts/run-scenario.*` (built by session A) when it exists; it does steps 1–5. Run it in the background and wait on its exit.

## Validity gate (`scenarioValid` from `@traceops/contracts`)
Build a `SignalSummary` from Prometheus over the run and check it before grading anything:
- both: baseline p95 < 0.5 s and no 5xx
- S1: latency alert fired · `used = max` for ≥ 60 s · timeouts > 0 · event-loop utilisation < 0.5 · `used` still `= max` after the load drop
- S2: latency alert fired · event-loop utilisation ≥ 0.9

An invalid run is **reported with its reasons, never graded**. For S2, if invalid because utilisation < 0.9, suggest raising `CPU_ITER`; don't change it silently.

## Afterwards
Restart demo-service with `FAULT=none` so the next run's baseline is clean, and note the time: the next scenario can start 5 minutes later.
