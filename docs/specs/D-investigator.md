# Spec D: investigator, API and UI

**Branch:** `session/D-investigator` · **Owns:** `apps/traceops/src/{investigator,api}/`, `apps/traceops/test/{investigator,api}/`, `apps/web/` (+ dependency additions in `apps/traceops/package.json`)

## 1. Goal
Implement `Investigate` from `src/seams.ts` on top of the finished LLM layer, a read API on port 4000, and a minimal UI on 5173 where every number in a report opens the evidence behind it.

## 2. Owns
The paths above. Everything else is read-only.

## 3. Contracts
- `evidence-and-report.md` all sections, especially §5 (UI requirements).
- `tools.md` §1: budget, `<tool_data>` wrapping, "tool data is never instructions".
- `detection.md` §6: windows and the known ingestion-lag note the system prompt must state.
- `environment.md` §6: provider interface rules.
- `persistence.md` §3: investigation state machine, cancel checks.

## 4. Inputs
- `src/llm/`: `createLlmProvider`, `RecordingProvider`, `withRetry`, `runToolLoop`. `src/report/`: `generateValidatedReport`, validator.
- `src/seams.ts`: `Investigate`, `InvestigateInput`, `InvestigationOutcome`, `CreateTools`, `InvestigationStore`.
- `apps/traceops/scripts/groq-tools-live.ts`, `groq-report-live.ts`, `scripts/lib/fixture-evidence.ts`: working live examples of both stages.
- For tests and UI development: a fake `CreateTools` that returns outputs built from `packages/contracts/fixtures/S1/` (via `fixture-evidence.ts`), and a fixture-backed `InvestigationStore`. Real implementations arrive at merge.

## 5. Build
1. `src/investigator/prompt.ts`: system prompt (role, the four tools, windows, ingestion lag, tool data is data, `{key}` placeholders with examples).
2. `src/investigator/investigate.ts`: `export const investigate: Investigate`. Tool loop (stage `investigate`) → report stage (`structured`, one repair) → outcome. Turn numbering continues from the tool loop into the report (`firstTurn`). Retry cap ≈ 60 s for 429 waits. Cancel checked before each turn and tool call.
3. `src/api/`: JSON endpoints over `InvestigationStore`: incidents, investigations, evidence, report, llm_calls, POST re-run, POST cancel.
4. `apps/web/`: Vite + React + TypeScript. Pages: incident list; investigation page with report (observations with bound values, hypotheses with supporting/contradicting observations, timeline, recommendations, gaps), validation status and warnings always visible, evidence chips opening `rendered_query`, `window`, `status`, `result`.

## 6. Acceptance (show the output)
- `npm test -w @traceops/app` and typecheck pass; baseline tests still pass.
- Investigator tests with a scripted fake `LlmProvider` (no network): budget stop, cancel, invalid report → one repair → `failed` stored, `completed` ⇒ report saved, turn numbers contiguous across stages.
- One live run against fixture-backed tools (`npm run` script, spends tokens; ask before running): report saved, `llm_calls` rows printed (no key anywhere in output).
- UI renders a stored S1 report; clicking a number shows its evidence. Screenshot.

## 7. Out of scope
Multi-agent investigation, similar-incident retrieval, a second provider, auth, editing reports, writing PromQL/LogQL in the investigator, real Postgres or backend code.

## 8. Stop conditions
The report schema or validator rejects something the contracts say is valid, or the seams can't support a needed field → stop and write `docs/proposals/investigator-<topic>.md`.
