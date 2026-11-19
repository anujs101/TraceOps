# Proposal: `log_volume` range selector must follow the step

**Status:** PROPOSED (branch `session/B-tools`). Not applied: needs a `contracts/*` branch and the `contract-change` skill.
**Found by:** `/code-review` (fresh context) and contract-guardian, independently.

## Problem
`tools.md` §6 fixes the LogQL as `sum by (severity_text) (count_over_time({service_name="$svc"}[1m]))`. The tool queries it with `step = stepFor(window, 60)`, which doubles to 120 s once a window exceeds 59 min (60-point series cap, `LIMITS.maxSeriesPoints`). Each point then counts only the last 1 of every 2 minutes. The output is labelled "log lines per minute" and `stats.sum` / `total.sum` are citable by the report, so both the series and the sum cover about half of the window's lines.

## Evidence
- `apps/traceops/src/tools/render.ts` `stepFor`: `ceil(spanS / (59 * 60)) * 60`, so spans over 3540 s give 120 s, over 7080 s give 180 s (spans are capped at 60 min, so only 120 s occurs).
- `renderVolumeQuery` hard-codes `[1m]`; asserted by `test/tools/render.test.ts:82` and `tools.test.ts:141`.
- Arithmetic: a 60-min window, step 120 s, 30 points, each the count over 1 min, so `sum` is about 50% of the true count.

## Does it affect the demo? (S1 / S2 windows via `deriveWindows`)
No for the captured scenarios. Incident window = `[started_at - 2 min, investigationStart]`; baseline = the 15-min-capped period before it; neither is capped at 60 min.

| Scenario | incident window | baseline window | step | doubled? |
|---|---|---|---|---|
| S1 (`manifest.json`: deploy 18:25:39, capture end 18:30:39) | 7.0 min | 7.0 min | 60 s | no |
| S2 (deploy 18:32:37, capture end 18:36:04) | 5.45 min | 5.45 min | 60 s | no |

The threshold is a span over 59 min. It is reached only when:
1. the model passes an explicit `{start, end}` of 59–60 min (allowed, since `allowed` reaches back 60 min before `started_at`), or
2. the investigation starts more than 57 min after `started_at` (e.g. a long-queued incident).

A normal live S1/S2 run uses the default incident or baseline window, so its volumes stay correct. The bug only shows if the model asks for a long explicit window.

## Proposed change
`tools.md` §6 and `renderVolumeQuery`: use `[${step}s]` as the range selector, so each point counts the whole interval it represents and `sum` is the true number of lines. `step_s` is already in the output. Update the "lines per minute" wording to "lines per `step_s`" (when `step_s` is 60 the two are equal). The two assertions above change with it.

## Alternative (also a contract change)
Keep `[1m]`, fix the step at 60 s and raise the volume series cap to 61 points, so a 60-min window never doubles. This touches `LIMITS.maxSeriesPoints` and `LogVolumeOutput`, so it is more invasive.

## Interim behaviour on this branch
Unchanged: `[1m]` with a doubled step above 59 min. Nothing else depends on it.
