# TraceOps — handover after the preparation phase (2026-11-17)

Read this first in a new session. Preparation is finished; the next step is implementation.

## Repository
- **Root:** `~/Developer/2027/spike_test` (git repo; no remote). `.env` holds `GROQ_API_KEY` / `GROQ_MODEL` and is gitignored.
- **Branches** (linear history; `main` was never created):

| Branch | Head | Contains |
|---|---|---|
| `spike/observability` | `fb23d66` | first OTel → otel-lgtm spike |
| `design/contracts` | `05cad4a` | **Contracts v1 (frozen)**: docs, `packages/contracts`, real fixtures |
| `feat/llm-groq` | `155318e` (+ this note) | **Groq integration**: `apps/traceops/src/llm`, `src/report`, tests, v1.1 proposal |

## Tests
Run each suite from its package folder:
```bash
cd packages/contracts && npm ci && npm test && npm run typecheck   # 92 tests
```
```bash
cd apps/traceops && npm ci && npm test && npm run typecheck        # 69 tests
```
No Docker, network or API key needed. The live scripts in `apps/traceops/scripts/` do need the key, and they spend tokens.

## Where things are
| Path | What |
|---|---|
| `docs/contracts/` | **Contracts v1 (frozen).** README lists verified items, open VERIFY items, untested assumptions |
| `docs/research/` | experiment evidence: `spike-observability.md`, `pool-lab.md` (S1/S2 numbers, findings) |
| `docs/proposals/contracts-v1.1.md` | **proposed, not applied**: provider-neutral `llm_calls`, LLM env vars, wording |
| `packages/contracts/` | zod schemas, metric templates, numeric-grounding rules, grading, fixtures S1/S2 |
| `apps/traceops/src/llm/` | provider-neutral `LlmProvider` (`chat` / `structured`), tool loop, recorder, retry, errors; `groq/` adapter |
| `apps/traceops/src/report/` | validator V0–V8, `generateValidatedReport` (exactly one repair round) |
| `spike/` | throwaway lab code (pool lab, capture scripts). **Not** the demo service |

## Decisions that are settled (don't re-litigate)
1. TraceOps is an investigation layer over Prometheus + Loki (via `grafana/otel-lgtm:0.40.0`); traces, multi-agent investigation and code tools are Tier 2.
2. Detection is deterministic and fires on **symptoms** (p95, 5xx), never causes. No LLM in monitoring.
3. Postgres job queue (`SKIP LOCKED` + leases); no Redis.
4. Single investigator agent; tools are fixed templates; the service is bound from the incident; tools run in our code only.
5. Evidence-first reports: `{key}` placeholders bound to evidence values; deterministic validator; one repair round; failures stored as `validation: failed`, never edited.
6. Pool gauges are emitted by the demo service as export-time observable gauges (instrumentation-pg's are dropped via a View: stale under a leak). Gauge templates use `last_over_time(...[15s])`.
7. S1 = connection leak; S2 = CPU starvation **causing** pool saturation (cause-vs-effect test). Discriminators: event-loop utilisation, query p95, recovery after load drop.
8. LLM provider: **Groq**, `openai/gpt-oss-20b`, behind a provider-neutral interface. Tool calling and structured output are **separate requests**. Groq 400 `tool_use_failed` / `json_validate_failed` → retryable `invalid_generation`.

## Outstanding / not verified
- Contracts **v1.1** amendments: proposed, awaiting approval (`docs/proposals/contracts-v1.1.md`).
- **Groq throughput:** account limits are 1,000 RPD / **8,000 TPM** (from headers); TPD not exposed. A 4-tool investigation used ≈ 12.7K input tokens; one report + repair is ≈ 12K. Expect 429 waits (observed up to 34 s, above the default 20 s retry cap). Evaluation (5 runs/scenario) likely exceeds a free-tier daily budget. Check the account limits page before evaluation.
- The model often writes literal numbers instead of `{key}` placeholders. The validator catches this, and one repair fixed most but not all of it live.
- Contracts v1 VERIFY items still open: S2 stability under screen recording, detector behaviour in S2 (latency rule only), redaction test corpus. (The live structured-output check is now done with Groq; that v1 item was written for Anthropic.)
- S2 fixtures: baseline overlaps the S1 tail (see `fixtures/S2/manifest.json`).
- `apps/traceops` links contracts via `file:`; npm workspaces (environment.md §3) are not set up yet.

## Environment left running
Lab containers from `spike/docker-compose.yml`: `spike-lgtm-1` (ports 3000/3100/4318/9090) and `spike-postgres-1` (5432). They hold only lab data. Stop them with:
```bash
cd spike && docker compose down
```
They conflict with the ports in `environment.md` (3000/3100/4318/9090/5432), so stop them before starting `infra/compose.yml`.

## Recommended first step for implementation
Branch from `feat/llm-groq`. Decide on v1.1, then build in the order the contracts allow parallelism:
1. `infra/compose.yml` + `apps/demo-service`, following telemetry.md exactly (preload OTel, Views, export-time gauges, 500 + error log on acquire timeout). Owner: demo/infra session.
2. In parallel: `apps/traceops` tool adapters (Prometheus/Loki → tool outputs), tested against `packages/contracts/fixtures`.
3. Then detector → job queue → investigator (reusing `src/llm` and `src/report`) → minimal UI → evaluation.
