# Proposal: enforce the metric share of the tool budget and decode JSON-string args (contracts v1.5)

**Status:** accepted by the operator 2026-11-19 (round 2: "enforce in code, model is untrusted").

## Problem
- The investigator prompt reserves 4 of the 12 tool calls for log tools ("at most 8 query_metric calls"). The model ignores it: S1 `docs/runs/s1-20261119T142737Z` made 12 `query_metric` calls (10 ok + 3 refused), S2 `docs/runs/s2-20261119T144936Z` made 10; log calls were then refused with `budget_exhausted`.
- Calls with JSON-encoded string arguments are rejected (`invalid_input: expected object, received string`, S2 run 1 ev_8), costing one call each.
- tools.md §1 only knows the 12-call / 3-min budget and "fails `*Checked` = invalid input", so enforcing either in the tool layer would diverge silently.

## Proposed change
- tools.md §1: `query_metric` gets at most `maxToolCalls − logCallReserve` (8) calls; the next returns `budget_exhausted` with a message naming the limit and the log tools; the row counts toward the 12.
- tools.md §1: a JSON-string argument is decoded once; an object result goes through `*Checked`; anything else stays invalid input (stored raw).
- `LIMITS.logCallReserve = 4` in `packages/contracts/src/tools.ts`.

## Affected sessions
Tool layer (session B paths, `apps/traceops/src/tools/runtime.ts`) and the investigator prompt (which reads the same constant). No schema or fixture change.
