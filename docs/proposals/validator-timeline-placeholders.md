# Proposal: V3 must check `{key}` placeholders in timeline events

**Status:** PROPOSED (branch `session/F-ui`). Not applied: the validator belongs to the LLM/report layer, and the binding rule is a contract question (`evidence-and-report.md` §3/§4).
**Found by:** the UI redesign, while rendering the recorded live run.

## Problem
`evidence-and-report.md` V3 says a report fails when "a `{key}` has no value". The validator checks observation and hypothesis placeholders. For the summary it forbids them. **Timeline events are never checked:** `apps/traceops/src/report/validator.ts:70–78` runs `quantities(t.event)` (bare numbers) but not `placeholders(t.event)`. A timeline can therefore cite a `{key}` that no observation binds, and the report still passes as **Validated**.

Timeline entries have no `values` of their own (`ReportApi.timeline: {at, event, evidence_ids}`), so the contract also never says which values a timeline placeholder may use. The UI binds against every observation value (keys are unique report-wide).

## Evidence
- `docs/runs/s1-20261119T104115Z/report.json`: `validation: "passed"`, yet
  - `timeline[1].event` uses `{pool_used_early}`
  - `timeline[2].event` uses `{pool_used_mid}`
  - Neither key appears in any `observations[].values`. Check: `python3 -c "import json,re;r=json.load(open('docs/runs/s1-20261119T104115Z/report.json'))['report'];k={v['key'] for o in r['observations'] for v in o['values']};print([m for t in r['timeline'] for m in re.findall(r'\{([a-z0-9_]+)\}',t['event']) if m not in k])"` prints `['pool_used_early', 'pool_used_mid']`.
- The UI shows them as marked-unbound placeholders (red, wavy underline), next to a "Validated" seal.

## Proposed change
1. `evidence-and-report.md`: state that timeline placeholders bind to observation values. Either:
   - any observation's value, or
   - only values whose `evidence_id` is in the event's `evidence_ids` (stricter, and the same idea as the hypothesis rule).
2. `validator.ts` V6 loop: for each `placeholders(t.event)` without a binding, raise a `V3` violation at `timeline.<i>.event`, using the same message as for observations.
3. Add a validator test built from this run's report, which must then fail V3 twice.
