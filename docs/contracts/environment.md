# Contract: shared local environment and integration conventions

**Status:** frozen v1 (2026-11-17) · **Executable source:** `packages/contracts/src/environment.ts` · New in rc2 (fixes integration risks I2–I6).

## 1. Ports (single source: `PORTS`; a test asserts they're unique)
| Service | Port |
|---|---|
| Grafana (debugging only) | 3000 |
| Loki HTTP API (published explicitly, not by the upstream image) | 3100 |
| OTLP HTTP in | 4318 |
| Prometheus HTTP API | 9090 |
| PostgreSQL (one container) | 5432 |
| demo-service | 8080 |
| TraceOps API | 4000 |
| TraceOps UI (dev) | 5173 |

## 2. Containers and ownership
- **One compose file:** `infra/compose.yml`, owned by the **demo/infra session**. It contains `grafana/otel-lgtm:0.40.0` (`mem_limit: 2g`) and a pinned `postgres` image (`mem_limit: 256m`) with **two databases**, `demo` and `traceops`, created by an init script. The TraceOps session never edits it; it needs only env vars.
- demo-service, the load generator and TraceOps run as host Node processes during development (faster iteration, less memory). Containerising them is out of MVP scope.
- Measured footprint: otel-lgtm ≈ 0.9 GB idle, ready in ≈ 2 min from a cold start.

## 3. Runtime conventions
| Item | Decision | Why |
|---|---|---|
| Node | 24.x | installed (24.6.0) |
| Workspaces | npm workspaces: `packages/contracts`, `apps/demo-service`, `apps/traceops`, `apps/web` | one lockfile; contracts imported, never copied |
| demo-service module format | compiled to CommonJS, OTel bootstrap preloaded with `--require` | ESM hoisting silently disables instrumentation (spike finding) |
| TraceOps module format | free (ESM fine) | not instrumented |
| Contract types | import from `@traceops/contracts`; **no hand-written duplicates** | prevents drift |
| Tests | Vitest | used by the contracts package |

## 4. Configuration (env vars; no secrets in the repo)
| Var | Used by | Example |
|---|---|---|
| `DATABASE_URL` | demo-service | `postgres://demo:demo@localhost:5432/demo` |
| `TRACEOPS_DATABASE_URL` | TraceOps | `postgres://traceops:traceops@localhost:5432/traceops` |
| `PROMETHEUS_URL`, `LOKI_URL` | TraceOps | `http://localhost:9090`, `http://localhost:3100` |
| `ANTHROPIC_API_KEY` | TraceOps | read by the SDK; never logged; never in fixtures |
| `FAULT`, `CPU_ITER`, `SERVICE_VERSION` | demo-service | see `scenario-db-pool.md` |

## 5. Fixtures (integration contract for the TraceOps session)
- `packages/contracts/fixtures/<scenario>/` holds **raw** Prometheus and Loki API responses captured from real lab runs by `spike/pool-lab/capture-fixtures.sh`, plus a `manifest.json` (window, backend version).
- TraceOps adapters are tested against these. **Hand-written backend mocks are not allowed.** A test asserts every fixture matches the backend response schemas in `backend.ts`.
- When telemetry changes, recapture the fixtures and they must still pass.
