# Proposal: `error_ratio_5xx` must be 0, not empty, when there are no 5xx responses

**From:** main session (Wave 2, after live S1 runs 1 and 2) · **Severity:** blocks normal incident resolution · 2026-11-19 · **Status:** OPEN, needs a decision and a `contracts/*` change

## Problem
`METRIC_TEMPLATES.error_ratio_5xx` (`packages/contracts/src/telemetry.ts`):
```
sum(rate(http_server_request_duration_seconds_count{service_name="$svc",http_response_status_code=~"5.."}[1m]))
  / sum(rate(http_server_request_duration_seconds_count{service_name="$svc"}[1m]))
```
When the service sends no 5xx responses, no `5..` series exists in the `[1m]` window, so the numerator is empty and the division is empty.

That interacts with two other contract rules:
- `detection.md` §3: "**Missing data** (empty result, NaN, query error): no transition … It never resolves an incident."
- §4: "**Resolve** when every rule in the group is `ok`."

Together they mean that once the `http-slo` group fires, the `http-error-ratio` rule can never return to `ok` on a healthy service. **No `http-slo` incident can ever resolve normally.** It stays `open` until someone edits the database. A later breach then *updates* the stale incident and enqueues nothing, so it is never investigated.

## Evidence
- **Live S1 run 2 app log (2026-11-19):** `[detector] missing data {"rule":"http-error-ratio","reason":"empty"}` on 12 ticks, including the whole healthy baseline (FAULT=none at 30 rps, 10:41:23–10:42:53Z). During those ticks the latency rule evaluated normally.
- **Run 1 evidence `ev_4`:** `query_metric error_ratio_5xx` over the healthy baseline window returned `status: "empty"` (`docs/runs/s1-20261119T102626Z/evidence.json`).
- **Run 1's incident** stayed `open` and had to be resolved by SQL before run 2 (`docs/runs/s1-20261119T104115Z/summary.json`, `pre_run_data_change`). Run 2's incident `d9d57f65…` is open now for the same reason.

## Proposed change (v1.3)
Make the numerator 0 when no 5xx series exists, while still returning empty when the service sends no traffic at all (a real "no data" case):
```
(sum(rate(…{…,http_response_status_code=~"5.."}[1m])) or vector(0))
  / sum(rate(…{service_name="$svc"}[1m]))
```
- With traffic and no 5xx the result is `0`, so the rule is `ok` and the group can resolve.
- With no traffic the denominator is empty, so the result is still empty and counts as missing data. That is unchanged, and correct.
- With 5xx the result is unchanged.

**Files:**
- `packages/contracts/src/telemetry.ts`: the template, plus a test running the rendered query against the fixtures. `prom-empty` / the S1 matrices should show 0 where they showed empty.
- `docs/contracts/detection.md` / `tools.md` §3: note that `error_ratio_5xx` is 0 (not empty) for a healthy service.
- The S1/S2 fixtures, which may need recapturing for `error_ratio_5xx`. Today's fixtures were captured with the old query, so check whether any file holds this query's output.

`query_metric error_ratio_5xx` changes the same way: a healthy baseline then returns `ok` with 0s instead of `empty`, which also makes incident-vs-baseline comparisons possible.

## Affected
- C's detector: no code change; the template is rendered from the contract.
- B's tools: no code change.
- `/s1-run`: once this lands, the "wait until the incident resolves" step (requested 2026-11-19) can be added. Without it, that step would always hit its cap.

## Until then
`/s1-run` keeps needing a pre-run cleanup of the previous run's open incident. That is a database edit and must be reported in the run record, as it was for run 2.
