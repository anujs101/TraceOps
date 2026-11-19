# Handoff: session/B-tools (spec B, tool adapters)

## Done and verified
- `/verify` run in this session, no errors or failures: typecheck clean in both workspaces; contracts 110/110 (baseline 110); @traceops/app 270/270 (baseline 96, +174 new, all in `test/tools/`).
- `/contract-check` against `main`: CONTRACTS UNCHANGED (contracts, docs/contracts, seams.ts untouched).
- Spec Build steps 1–5, as 6 commits (b3a34dd, 19a026c, d2001d5, 3025d2e, 8df2656, plus this handoff): backend clients, render, redact + sanitized errors, the four tools, `createTools`.
- Every S1 and S2 fixture is replayed through its adapter; output checked against `TOOL_OUTPUTS`, row against `Evidence`, stats against `deriveStats` and `STATS_KEY_GRAMMAR`.
- Also tested: invalid input (raw args, null query/window, no backend call), window outside `allowed`, empty ≠ 0, budget, `ev_N` numbering incl. parallel, allowlist (no `exception_stacktrace`), string→number parsing, ns→IsoUtcMs, abort, backend-error sanitising.
- Redaction corpus (VERIFY item 4 in contracts README): 17 must-redact + 11 must-survive cases pass. The README item itself is main-session-owned, so I did not edit it.
- Mutation check: letting `exception_stacktrace` through made 6 tests fail; restored.

## Done, not verified
- Nothing run against live Prometheus or Loki. Request shape (`query_range`, `categorize-labels` header, ns timestamps) is checked only against our own assertions and the fixtures.
- Loki empty-result tests use a real fixture with `result: []` (no empty Loki fixture exists).
- `/code-review` and `contract-guardian` not run on this branch yet.

## Not done
- Nothing from the spec's Build list is outstanding.

## Deviations and proposals
- No proposals written. No contract or fixture mismatch found.
- Judgment calls: pre-execution failures (invalid input, budget, render error) return `{evidence_id, status, error}`, not a full `TOOL_OUTPUTS` shape (no window exists); backend failures return the full shape with empty data. Only 3 severities appear in `log_volume`; others are dropped. `log_patterns` shows normalised messages (`<n>`, `<uuid>`, `<hex>`). Series step grows (15 s / 60 s base) to stay ≤ 60 points.

## How to run it
- `npm test -w @traceops/app -- test/tools` · `npm run typecheck` · `npm test`
- If vitest cannot load rolldown: `npm install --no-save --no-package-lock @rolldown/binding-darwin-arm64@1.2.19`

## For the integrator
- Wire `createTools` from `apps/traceops/src/tools/index.ts` (the `CreateTools` seam). `createToolsWith({fetch, timeoutMs})` is the test seam.
- **Tool loop (D's decision):** `wrapToolData` emits `<tool_data call_id=…>`, tools.md says `evidence_id="ev_N"`. Also, malformed-JSON arguments are rejected in `runToolLoop` before `run`, so those calls get no evidence row. Our tools' `args` schema is `z.unknown()` so everything else reaches `run`.
- An abort records one error row (`aborted`), then throws; the loop reports `tool_error`.
- `ToolContext` has no fetch; tools use global `fetch`. `package-lock.json` has an uncommitted change that predates this branch; regenerate at merge, don't commit it from here.
- No new dependencies were added to `apps/traceops/package.json`.
