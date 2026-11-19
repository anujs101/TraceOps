# apps/traceops — rules for this workspace

- **LLM access only through `src/llm/index.ts`** (`createLlmProvider`, `LlmProvider`). Never import `groq-sdk` outside `src/llm/groq/`.
- **Tool use and structured output are separate requests.** Tools go through `runToolLoop`; the report goes through `generateValidatedReport` (exactly one repair round, `MAX_REPAIR_ROUNDS`). Don't reimplement either.
- **The model never sees PromQL, LogQL, URLs or credentials.** Queries come only from `METRIC_TEMPLATES` / the LogQL rules in `tools.md`; `service` is bound from the incident.
- **One evidence row per tool call**, including invalid input (`args` = raw input, `rendered_query: null`) and `budget_exhausted`. `stats` come from `deriveStats()`, never from the model.
- **Our code never edits a report.** A report failing after repair is stored with `validation: 'failed'`.
- **Every timestamp leaving this app is IsoUtcMs** (`toIsoUtcMs`).
- **Every LLM attempt becomes one `llm_calls` row** via `RecordingProvider` + `toLlmCallRow()`.
- Interfaces between sessions are in `src/seams.ts` (read-only).
- Tests: Vitest, under `test/<area>/`. Backend responses come from `packages/contracts/fixtures/`, never hand-written.
