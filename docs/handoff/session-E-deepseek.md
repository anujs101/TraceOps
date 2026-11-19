# Handoff: session/E-deepseek

**Done and verified** (/verify 2026-11-19: typecheck passes in all 3 workspaces; tests: contracts 113/113, demo-service 12/12, app 379 passed + 72 Postgres-gated skips that predate this branch, including 55 new DeepSeek tests)
- `src/llm/deepseek/`: config (`DEEPSEEK_*`; host only, `/beta` appended because strict mode needs it), adapter (`openai` SDK, `maxRetries: 0`, `thinking: disabled`), strict schema check, `createDeepSeekProvider()`.
- `chat()`: every tool is sent with `strict: true` and `tool_choice: auto`.
- `structured()`: one strict tool `submit_report` with the report schema, forced via `tool_choice`, and its parsed arguments are returned. No `response_format` (DeepSeek has no json_schema mode). `Report`, V0–V8 and repair are unchanged.
- `llm_calls` rows go through `RecordingProvider` and pass `LlmCall.parse` with `provider: 'deepseek'`.
- Error mapping:
  - 401/402/403 → `auth`; 402 means insufficient balance and needs an operator
  - 408 → `timeout`; 429 → `rate_limit` (`retry-after` honoured if sent)
  - 503 → `capacity`; 500/504/other 5xx → `server`; other 4xx → `bad_request`
  - SDK timeout/connection/abort → `timeout`/`connection`/`aborted`
  - No 400 maps to `invalid_generation`: DeepSeek documents none and none was seen live.
- Live smoke, one run on 2026-11-19 (raw output in this session's transcript):
  - strict mode accepted all 4 tool schemas and ReportApi; no keyword was rejected
  - API-reported model is `deepseek-flash`
  - chat produced 6 valid tool calls
  - `submit_report` returned valid JSON
  - `Report.safeParse` failed on 2 empty `supporting_observation_ids`. That's the min-1 rule ReportApi can't express, so it becomes a `schema_violation` and goes to the repair round.
- Wire-schema stripping (`toDeepSeekWireSchema`, pure and tested) removes `minLength`/`maxLength`/`minItems`/`maxItems`/`uniqueItems`. **It's a no-op today:** the current contract schemas have none of these, so the wire schema equals the contract schema. Zod still enforces any such constraints locally.

**Done, not verified**
- Repair round and a full investigation on DeepSeek. Not run: the selector isn't wired yet, and only one live run was approved.

**Not done**
- Selector wiring in `src/llm/index.ts`, which E doesn't own. See the proposal below.

**Deviations and proposals**
- [docs/proposals/deepseek-selector-wiring.md](../proposals/deepseek-selector-wiring.md): the selector diff, the `contracts-v1.1.test.ts:27` update, closing the open points in env §6, and `sk-` key redaction in shared `redactSecrets`.
- The live smoke lives in `test/llm/deepseek/live-smoke.ts` (not `scripts/`, which E doesn't own). It isn't a `*.test.ts` file, so vitest skips it.

**How to run it**
- `npm test -w @traceops/app -- test/llm/deepseek`
- Live (spends tokens): `(set -a; . ./.env; set +a; npm run smoke:deepseek -w @traceops/app)`
- Once wired: `LLM_PROVIDER=deepseek` plus `DEEPSEEK_API_KEY`. Groq stays the default.

**For the integrator**
- New dependency: `openai ~7.60.0` in `apps/traceops/package.json`. `package-lock.json` is **not committed**, so regenerate it at merge. A workspace-scoped `npm install` (`-w`) here dropped every optional platform binding (npm/cli#4828). Only a clean `rm -rf node_modules */*/node_modules package-lock.json && npm install` kept them.
- Apply the wiring proposal, then update `contracts-v1.1.test.ts:27`.
- `LLM_DEFAULTS.deepseek.model = 'deepseek-flash'` is confirmed live, so no amendment is needed.
