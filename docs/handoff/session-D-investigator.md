# Handoff: session/D-investigator (2026-11-19)

## Done and verified
- `/verify` this turn: typecheck pass in contracts, app, web; tests contracts 110/110, @traceops/app 146/146 (baseline 96), @traceops/web 11/11.
- `src/investigator/`: prompts; `investigate()` (tool loop → validated report with 1 repair; turns contiguous; cancel checked before every model request, tool call and pacing wait; 429 waits ≤ 60 s). A saved report with `validation: failed` maps to investigation `completed` (persistence.md §2).
- Provider-neutral TPM pacing (`pacing.ts`), keyed by provider name: groq 7500/min, deepseek off, unknown off. Per-request report output cap. `org_` ids redacted from `investigations.error`.
- Handles the tool layer's short error shape `{evidence_id, status, error}` (investigator and UI tests).
- `src/api/`: node:http read API on 4000 over `InvestigationStore`; `MemoryStore`; dev seed built by the real `investigate()` over the S1 fixtures (dev data only, never demo evidence).
- `apps/web/`: Vite + React UI; each bound number opens its evidence (query, window, status, result, value check). Screenshots taken with headless Chrome (dev seed, not the live run).

## Done, not verified
- Pacing against a real provider: unit-tested with a fake clock only, because no live run was made after it was added (on hold until session E's DeepSeek adapter is merged).
- One live Groq run (12:09, before pacing) **failed**: 8 × 429, then out of retries at the report stage; no report saved. Totals: 27,718 input and 529 output tokens, 167.7 s. Acceptance item "live run: report saved" is still open.

## Not done
- A live run with a saved report (blocked: waiting for E's adapter, by instruction).
- Build-log line: the hook blocks `docs/build-log.md`; the agreed path is pending (`docs/build-log/D-investigator.md`?).
- Not built: smaller report requests (stats without series) and extra retries for rate limits only.

## Deviations and proposals
- [investigator-tool-data-wrapper.md](../proposals/investigator-tool-data-wrapper.md): `call_id` vs `evidence_id` wrapper attribute; cosmetic.
- [llm-redact-account-ids.md](../proposals/llm-redact-account-ids.md): `llm_calls.error_message` keeps Groq `org_` ids (`src/llm/` is not D's).

## How to run it
- Tests: `npm test -w @traceops/app` · `npm test -w @traceops/web` · `npm run typecheck`
- UI over the dev seed: `npm run dev:api -w @traceops/web` (API :4000), then `npm run dev -w @traceops/web` (UI :5173)
- Live (spends tokens, ask first): `npx tsx apps/traceops/src/investigator/live-run.ts`

## For the integrator
- Wire with `investigate` (`src/investigator/investigate.ts`) and `createApiServer(store)` / `startApi(store)` (`src/api/server.ts`) over C's store.
- Tools: the investigator replaces each tool's `args` with `z.unknown()`; B validates inside `run` (confirmed).
- `ScriptedProvider` is named `groq` so its rows map onto `llm_calls`. Callers using it must pass `pacing: null`.
- New workspace `apps/web` (adds react, vite plugin, jsdom, testing-library). Root `package-lock.json` is not committed; regenerate it at merge and check the platform bindings survive (npm/cli#4828 hit this worktree).
- When DeepSeek lands, add its name to `LLM_PROVIDERS` and review `PROVIDER_PACING`. `live-run.ts` scans every `*_API_KEY` value.
