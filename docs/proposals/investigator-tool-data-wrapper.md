# Proposal: `<tool_data>` wrapper attribute (`call_id` vs `evidence_id`)

**From:** session D (investigator) · **Severity:** cosmetic, **not blocking** · 2026-11-19

## Problem
`tools.md` §1 says tool output is wrapped as `<tool_data evidence_id="ev_N">…</tool_data>`.
The finished tool loop (`apps/traceops/src/llm/tool-loop.ts`, `wrapToolData`) emits
`<tool_data call_id="<provider tool-call id>">…</tool_data>`. Session D does not own `src/llm/`.

## Evidence that it is cosmetic
The model still sees the evidence id on every successful tool call, in the JSON body:
- `QueryMetricOutput`, `SearchLogsOutput`, `LogPatternsOutput`, `LogVolumeOutput`
  (`packages/contracts/src/tools.ts`) all have a required `evidence_id` field.
- `evidence-and-report.md` §1: `Evidence.result` is "exactly what the model saw", and
  `scripts/lib/fixture-evidence.ts#toEvidence` builds it as `{ evidence_id, ...output }`.
So citations (`evidence_ids`, `values[].evidence_id`) are possible.

## Related gap (handled in D without changing contracts)
`runToolLoop` short-circuits three cases **before** the tool's `run` is reached, returning
`{error, detail}` with **no `evidence_id` and no evidence row**:
1. `tool.args.safeParse` fails (`invalid_args`). This contradicts tools.md §1: "every call, including rejected ones, becomes an evidence row".
2. `toolRuns.length >= maxToolCalls` (`budget_exhausted`), the same contradiction.
3. Unknown tool name or non-JSON arguments. No `Evidence.tool` value can represent these, so they remain without a row.

Mitigation in `src/investigator/investigate.ts`: the investigator wraps each tool from
`CreateTools` with a pass-through `args` schema, so the tool's own `run` (which per
`seams.ts` validates `*Checked` and appends exactly one row, also for invalid input and
budget exhaustion) handles 1 and 2. The loop's own `maxToolCalls` is set above the
contract budget and is only a backstop. **Session B must therefore validate inside
`run`**, which is what `seams.ts` already says.

For the report stage, the investigator re-presents all collected evidence using the
contract wrapper `<tool_data evidence_id="ev_N" tool=… source=…>` (as the verified
`scripts/groq-report-live.ts` does), so the model writes its citations from rows that carry the contract attribute.

## Proposed change (main session decides)
Either
- (a) amend tools.md §1 to "wrapped as `<tool_data …>`; the output body carries `evidence_id`", or
- (b) change `wrapToolData` to take the evidence id when the result carries one.

Recommendation: (a). It is a docs-only change and matches what already works.
