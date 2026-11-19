# TraceOps

AI incident investigator over Prometheus + Loki. Deterministic detection opens an incident; a single LLM investigator calls four fixed tools; a deterministic validator (V0–V8) decides whether its report is proven.

Read first: `docs/contracts/README.md` (what is frozen and verified), then your spec in `docs/specs/`.

## Layout
| Path | What |
|---|---|
| `packages/contracts/` | `@traceops/contracts`: zod schemas, templates, grading, real S1/S2 fixtures. **Frozen.** |
| `docs/contracts/` | the contract docs. **Frozen.** |
| `apps/traceops/src/seams.ts` | interfaces between build sessions. **Frozen.** |
| `apps/traceops/src/llm/`, `src/report/` | finished LLM layer (provider interface, Groq, tool loop, validator, repair) |
| `apps/demo-service/`, `infra/` | demo shop + compose stack (session A) |
| `apps/web/` | UI (session D) |
| `docs/OWNERSHIP.md` | which branch may edit which paths (enforced by a hook) |
| `docs/specs/` | one brief per build session |
| `spike/` | throwaway lab code. Never import from it. |

## Commands (run from the repo root)
```bash
npm test                 # all workspaces (baseline: contracts 110, traceops 96)
npm run typecheck        # all workspaces
npm test -w @traceops/app        # one workspace
```
Live scripts in `apps/traceops/scripts/` spend Groq tokens; run them only when asked.

## Rules
1. **Contracts, seams and fixtures are read-only.** If one looks wrong, write `docs/proposals/<topic>.md` (problem, evidence, proposed change) and **stop**. Never diverge silently, never "fix" a contract to make your code pass.
2. **Edit only the paths your branch owns** (`docs/OWNERSHIP.md`). A `PreToolUse` hook blocks other writes; if it blocks you, that is the rule working, not a bug to route around (no `sed`/`cat >` workarounds via Bash).
3. **Import contract types from `@traceops/contracts`.** No hand-written duplicates. No hand-written Prometheus/Loki mocks: test adapters against `packages/contracts/fixtures/`.
4. **Secrets:** never read, print or cat `.env`. Never log `GROQ_API_KEY` or `DEEPSEEK_API_KEY`, or put them in fixtures, tests, `llm_calls` or output.
5. **Done means proven.** Before saying a step is done, run `/verify` and show the output. A claim without output is not done.
6. **Stay in scope.** Your spec's "Out of scope" list is binding. Tier 2 features (multi-agent, similar-incident retrieval, traces) are not built now. DeepSeek is in scope since Contracts v1.2, as session E's adapter only (`apps/traceops/src/llm/deepseek/`).
7. **Plan first.** Start each task in plan mode and wait for approval.
8. **Commit only when the user asks.** Never push. Never rewrite history.
9. Same approach failed twice → stop and ask.

## Ports (environment.md §1)
Grafana 3000 · Loki 3100 · OTLP 4318 · Prometheus 9090 · Postgres 5432 · demo-service 8080 · TraceOps API 4000 · UI 5173
