# Spec A: demo-service and infra

**Branch:** `session/A-demo` · **Owns:** `infra/`, `apps/demo-service/`

## 1. Goal
A demo shop that produces exactly the telemetry in `telemetry.md`, and fails on command as S1 (`pool_leak`) or S2 (`cpu_burn`), so that the S1 validity gate passes on a live run.

## 2. Owns
`infra/` and `apps/demo-service/`. Everything else is read-only (hook-enforced).

## 3. Contracts
- `environment.md` §1–§4: ports, `infra/compose.yml` (otel-lgtm `0.40.0` with `mem_limit: 2g`, Loki 3100 published explicitly; pinned Postgres with `mem_limit: 256m`; init script creating databases and users `demo` and `traceops`).
- `telemetry.md` all sections: resource attributes, bootstrap rules, metrics with single-source rule, logs, required logging, endpoints, pool config, fault flag.
- `scenario-db-pool.md`: S1/S2 ground truth, load profile, cool-down, validity gate.
- `apps/demo-service/CLAUDE.md`: the spike failures to avoid.

## 4. Inputs
- `@traceops/contracts`: `PORTS`, metric names, `FORBIDDEN_LOG_PHRASES`, `scenarioValid`, `SignalSummary`.
- `spike/pool-lab/` and `spike/docker-compose.yml`: reference implementations that worked in the lab. Read them; don't import them.
- `spike/pool-lab/capture-fixtures.sh`: how fixtures were captured.

## 5. Build
1. `infra/compose.yml` + Postgres init script. `docker compose -f infra/compose.yml up -d` brings everything up.
2. `apps/demo-service`: Express + `pg` + pino, TypeScript compiled to CommonJS, OTel bootstrap preloaded with `--require`. Endpoints `GET /products`, `POST /orders`, `GET /healthz`. Schema + seed (products with some zero-stock items).
3. Faults from env at startup: `FAULT=none|pool_leak|cpu_burn`, `CPU_ITER`, `SERVICE_VERSION`.
4. Load generator (`apps/demo-service/load/`): open loop, configurable rps (default 30), 80/20 mix, `LOW_STOCK_SHARE=0.02`.
5. Scenario script (`apps/demo-service/scripts/run-scenario.ts` or `.sh`): baseline ≥ 90 s on `1.0.0` → restart with the fault on `1.0.1` → load until the latency alert condition holds + 3 min → 6 rps for ≥ 60 s. Then queries Prometheus to build a `SignalSummary` and prints `scenarioValid()`.

## 6. Acceptance (show the output)
- `npm test -w apps/demo-service` and typecheck pass. Unit tests cover: fault flag parsing, the 409 path not releasing under `pool_leak` only, error handler → 500 + `request failed` with `err`.
- Live: after one S1 run, these return data in Prometheus with `service_name="demo-service"`: every metric in `telemetry.md` §3. `db_client_connection_count` has **one** series per state (no instrumentation-pg duplicate).
- Live: Loki returns `request failed` lines with `exception_message="timeout exceeded when trying to connect"`.
- Live: `scenarioValid('S1', …)` → `valid: true`. Paste the summary.
- No log line contains a `FORBIDDEN_LOG_PHRASES` phrase (test or grep).

## 7. Out of scope
TraceOps code, the detector, containerising the Node services, Grafana dashboards, any metric or log field not in `telemetry.md`. S2 tuning beyond the default `CPU_ITER=300000`.

## 8. Stop conditions
- A metric name, label or log field differs from `telemetry.md` when observed → stop, write `docs/proposals/telemetry-<topic>.md` with the observed query output.
- Ports clash with running containers → report; don't change ports.
