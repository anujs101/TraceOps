# Spec B: tool adapters

**Branch:** `session/B-tools` · **Owns:** `apps/traceops/src/tools/`, `apps/traceops/test/tools/` (+ dependency additions in `apps/traceops/package.json`)

## 1. Goal
Implement `CreateTools` from `src/seams.ts`: the four investigator tools, turning model arguments into fixed PromQL/LogQL, calling Prometheus/Loki, and returning allowlisted, redacted outputs with one evidence row per call.

## 2. Owns
`apps/traceops/src/tools/`, `apps/traceops/test/tools/`. Everything else is read-only.

## 3. Contracts
- `tools.md` §1–§8 (all of it): two schema layers, invalid-input handling, windows, IsoUtcMs, timeout + one retry, budget, `<tool_data>` wrapping, templates, LogQL rules, allowlist, redaction, pattern grouping, stats keys.
- `evidence-and-report.md` §1: the Evidence row.
- `detection.md` §6: `deriveWindows` for `"incident"` / `"baseline"` / `allowed`.
- `environment.md` §5: fixtures, no hand-written mocks.

## 4. Inputs
- `@traceops/contracts`: `TOOL_INPUTS`, `*Checked` schemas, `TOOL_OUTPUTS`, `METRIC_TEMPLATES`, `LogLine`, `LOG_LINE_KEYS`, `deriveStats`, `deriveWindows`, `toIsoUtcMs`, backend response schemas in `backend.ts`.
- `packages/contracts/fixtures/S1/`, `S2/`: real Prometheus and Loki responses.
- `src/seams.ts`: `CreateTools`, `ToolContext`, `EvidenceSink`. `src/llm/tool-loop.ts`: `LocalTool`.

## 5. Build
1. `src/tools/backend/`: thin Prometheus (`/api/v1/query_range`) and Loki clients, 5 s timeout, one retry on network error. Injectable `fetch` so tests replay fixtures.
2. `src/tools/render.ts`: PromQL from `METRIC_TEMPLATES`, LogQL per §4–§6, escaping, service-name check.
3. `src/tools/query-metric.ts`, `search-logs.ts`, `log-patterns.ts`, `log-volume.ts`: validate → render → fetch → shape output → `deriveStats` → evidence row.
4. `src/tools/redact.ts`: bearer/API tokens, `postgres://user:pass@`, emails, long hex/base64; truncation to 300 chars.
5. `src/tools/index.ts`: `export const createTools: CreateTools`, enforcing the budget (≤ 12 calls, deadline) and the evidence numbering `ev_1…`.

## 6. Acceptance (show the output)
- `npm test -w @traceops/app` and typecheck pass; baseline 96 tests still pass.
- For **every** S1 fixture, a test replays it through the adapter and checks the output against `TOOL_OUTPUTS` and the evidence against `Evidence`.
- Tests for: invalid input → `status: error`, raw `args`, `rendered_query: null`, no backend call; window outside `allowed` rejected; empty result → `status: empty` (never 0); budget → `budget_exhausted` row; fields outside `LOG_LINE_KEYS` never appear (`exception_stacktrace` especially); Loki string `status`/`duration_ms` parsed to numbers; nanosecond timestamps → IsoUtcMs.
- A small synthetic redaction corpus (closes contracts VERIFY item 4).

## 7. Out of scope
Raw PromQL/LogQL from the model, any fifth tool, traces, the investigator prompt, persistence (use the `EvidenceSink` you're given).

## 8. Stop conditions
A fixture doesn't match a contract schema, or a template returns something the contract doesn't describe → stop and write `docs/proposals/tools-<topic>.md`.
