# Handoff: session/B-tools (spec B, tool adapters)

## Done and verified
- `/verify` run in this session, no errors or failures: typecheck clean in both workspaces; contracts 110/110 (baseline 110); @traceops/app 285/285 (baseline 96, +189 new, all in `test/tools/`).
- `/contract-check` against `main`: CONTRACTS UNCHANGED (contracts, docs/contracts, seams.ts untouched).
- Spec Build steps 1–5, as 6 commits (b3a34dd, 19a026c, d2001d5, 3025d2e, 8df2656, plus this handoff): backend clients, render, redact + sanitized errors, the four tools, `createTools`.
- Every S1 and S2 fixture is replayed through its adapter; output checked against `TOOL_OUTPUTS`, row against `Evidence`, stats against `deriveStats` and `STATS_KEY_GRAMMAR`.
- Also tested: invalid input (raw args, null query/window, no backend call), window outside `allowed`, empty ≠ 0, budget, `ev_N` numbering incl. parallel, allowlist (no `exception_stacktrace`), string→number parsing, ns→IsoUtcMs, abort, backend-error sanitising.
- Redaction corpus (VERIFY item 4 in contracts README): 17 must-redact + 11 must-survive cases pass. The README item itself is main-session-owned, so I did not edit it.
- Mutation check: letting `exception_stacktrace` through made 6 tests fail; restored.

## Done, not verified
- Nothing run against live Prometheus or Loki. Request shape (`query_range`, `categorize-labels` header, ns timestamps) is checked only against our own assertions and the fixtures.
- Loki empty-result tests use a real fixture with `result: []` (no empty Loki fixture exists).
- Live behaviour of the deadline-capped timeout (only tested with fake fetches).

## Review fixes (`/code-review` + contract-guardian, applied after the handoff above)
- A throw in `execute`/`deriveStats` now records an `error` row (`internal_error: …`, redacted, ≤ 300 chars) and returns the short early form, so no `ev_N` gaps.
- `redact`: any `scheme://user:pass@host` is redacted (was a fixed list); `Basic` redacts only base64-looking tokens (needs a digit or `=+/`), so "Basic validation" survives. Trade-off: an all-letter, unpadded Basic credential is not caught by that rule.
- `getJson`: `BackendDeps.deadline` (set from `ctx.budget.deadline`) caps each attempt; nothing is sent after the deadline and no retry follows it.
- `search_logs` description: `message` is case-sensitive, `exception_message` case-insensitive.
- Two tests now build their Prometheus responses from real fixtures; `Window`/`Point`/`SeriesStats`/`LogFilter` types are derived from `@traceops/contracts`.
- `/code-review` and `contract-guardian` have now been run on this branch.

## Not done
- **`log_volume` under-count (open proposal `docs/proposals/tools-step-size.md`):** `[1m]` range with a step doubled above 59 min makes `sum` about half the real count. Contract change, so not fixed here. Does not affect the S1/S2 default windows (7.0 and 5.45 min, step 60 s); only explicit 59–60 min windows.
- Skipped on purpose: Loki 400 classified as `http` (not `backend`); `truncated` is true when exactly `limit` lines exist.

## Deviations and proposals
- One proposal: `docs/proposals/tools-step-size.md` (log_volume range vs step). No other contract or fixture mismatch found.
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
