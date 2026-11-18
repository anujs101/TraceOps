# Contract: shared local environment and integration conventions

**Status:** v1.1 (2026-11-18; §4 LLM variables and new §6, everything else unchanged from frozen v1) · **Executable source:** `packages/contracts/src/environment.ts` · New in rc2 (fixes integration risks I2–I6).

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
| `LLM_PROVIDER` | TraceOps | `groq` (default; the only implemented value) |
| `GROQ_API_KEY` | TraceOps | **required**; read only by the Groq adapter; never logged, never in fixtures or `llm_calls` |
| `GROQ_BASE_URL` | TraceOps | `https://api.groq.com` (default). The API **host** only: groq-sdk appends `/openai/v1/...`, so a value ending in `/openai/v1` is rejected. https required (http only for localhost) |
| `GROQ_MODEL` | TraceOps | `openai/gpt-oss-20b` (default; the model id every live Groq response reported) |
| `GROQ_TIMEOUT_MS` | TraceOps | `30000` |
| `GROQ_REASONING_EFFORT` | TraceOps | unset, or `low` / `medium` / `high` |
| `FAULT`, `CPU_ITER`, `SERVICE_VERSION` | demo-service | see `scenario-db-pool.md` |

Secrets live only in the git-ignored `.env` at the repo root. `.env.example` (committed) lists the variables with no values.

## 5. Fixtures (integration contract for the TraceOps session)
- `packages/contracts/fixtures/<scenario>/` holds **raw** Prometheus and Loki API responses captured from real lab runs by `spike/pool-lab/capture-fixtures.sh`, plus a `manifest.json` (window, backend version).
- TraceOps adapters are tested against these. **Hand-written backend mocks are not allowed.** A test asserts every fixture matches the backend response schemas in `backend.ts`.
- When telemetry changes, recapture the fixtures and they must still pass.

## 6. LLM provider (v1.1)
**Interface.** Investigator code depends only on `apps/traceops/src/llm/index.ts`: `createLlmProvider()` and the `LlmProvider` type. It never imports a provider SDK, which is used only inside `apps/traceops/src/llm/<provider>/`. `LlmProvider` has two capabilities:
- `chat()`: tool-calling turns (stage `investigate`)
- `structured()`: one JSON response constrained by a schema (stage `report`)

**Tool use and structured output are always separate requests.** Groq can't combine them in one request.

**Selection.** `LLM_PROVIDER` picks the adapter, and unknown values fail at startup. Adding a provider (for example DeepSeek) means adding an adapter directory, a value in `LLM_PROVIDERS` (`packages/contracts/src/llm.ts`), and its env vars here. No investigator code changes.

**Every adapter must:**
1. Map provider responses to the neutral types:
   - tool calls with their raw argument strings
   - stop reason `tool_calls | end | length | other`
   - usage as input/output tokens, or null if not reported
   - request id
2. For `structured()`, use the provider's strictest schema mode, and return parsed JSON. Server-side validation (`Report`, V0–V8) **always** runs afterwards, whatever the provider enforces.
3. Keep tool schemas and `ReportApi` within the provider's documented schema subset. They must pass `structuredOutputProblems()`, plus a provider-specific check such as `groqStrictProblems()`.
4. Map every SDK error into `LLM_ERROR_KINDS`, with `retry_after_ms` taken from the provider's header.
5. Disable the SDK's own retries, so every attempt is recorded.

**Groq specifics (implemented):**
- `groq-sdk`, `chat.completions.create`
- tools as `type: function`, `tool_choice: auto`
- structured output as `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`
- HTTP 400 with `tool_use_failed` or `json_validate_failed` → `invalid_generation`. Observed live, even in strict mode.

**Error handling:**
- **Retried:** only the kinds in `RETRYABLE_LLM_ERRORS`, with backoff that honours `retry_after_ms`.
- **Wait longer than the caller's cap:** the error is surfaced, not waited out.
- **Not retried:** `auth`, `bad_request`, `malformed_response` and `truncated`.
- **`schema_violation`:** handled by the single report repair round (`evidence-and-report.md` §4), not by retrying.
- **Records:** every attempt, failed or not, produces one `llm_calls` row (`persistence.md` §1a).
- **Error messages:** redacted of key-like strings before they're stored.
