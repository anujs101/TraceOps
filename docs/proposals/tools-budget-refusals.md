# Proposal: refused metric calls do not count toward maxToolCalls (contracts v1.6)

**Status:** accepted by the operator 2026-11-20 (overnight job step 1: "refused metric calls must NOT count toward maxToolCalls, so the log reserve survives").

## Problem
v1.5 (tools.md §1) counts a `query_metric` call refused by the metric share (8 of 12) toward the 12. The model keeps asking for metrics after the refusal (1–3 refused per run in round 2), and each refusal takes one call from the 4 reserved for log tools.

## Evidence (round-2 eval, `docs/runs/EVAL.md`)
- Every one of the 6 runs had ≥ 1 log call refused by the global budget.
- `s2-20261119T191005Z`: 1 log_volume + 8 ok + 3 refused query_metric = 12, so log_patterns ×2 and search_logs ×1 were all refused.

## Proposed change
- tools.md §1: a refused metric call is still recorded as an evidence row (raw args, `rendered_query: null`, `window: null`) but does not count toward the 12. Ids stay contiguous; an investigation may hold more than 12 rows. The 3-min deadline and the tool loop backstop (2 × 12 tool runs, 16 turns) bound the total.
- No schema, status, or fixture change.

## Affected sessions
Tool layer (`apps/traceops/src/tools/runtime.ts`). UI (session F) lists evidence rows; it must not assume ≤ 12.
