# Proposal: retune S2 `CPU_ITER` from 300000 to 400000 (contracts v1.4)

**Status:** accepted by the operator 2026-11-19 (calibrate, pick the smallest value meeting the criteria, apply via contract-change).

## Problem
`scenario-db-pool.md` fixes S2 at `CPU_ITER=300000`. On the current laptop that value no longer drives S2 into its intended state unless something else loads the machine:

| run | machine load (1 min) | p95 max | ELU max | valid |
|---|---|---|---|---|
| S2 run 1 (`docs/runs/s2-20261119T111534Z`) | ~14.9 (Spotlight indexing) | 2.14 s | 1.0 | yes |
| S2 attempt 1 (`docs/runs/s2-20261119T132445Z`) | ~6–10 | 0.81 s | 1.0 | no: latency alert did not fire |
| S2 attempt 2 (`docs/runs/s2-20261119T134241Z`) | ~3 | 0.08 s | 0.887 | no: alert did not fire, event loop not saturated |

The contract already anticipates this ("Known sensitivity … `CPU_ITER` may need retuning on the recording day"; README open item 2).

## Evidence: calibration (no TraceOps app, no LLM)
demo-service `FAULT=cpu_burn SERVICE_VERSION=1.0.1`, load 30 rps (`load/cli.ts`, `LOW_STOCK_SHARE=0.02`), 90 s per value, 30 s gap between values; metrics from Prometheus via the contract `METRIC_TEMPLATES`, step 5 s, ELU and p95 over the last 60 s of each value (skips warm-up and the `rate[1m]` fill), 5xx ratio and pool used over all 90 s. Machine load 3.7 → 2.9. Raw data and scripts: `docs/runs/calib-s2-cpu-iter-20261119T143732Z/`.

| CPU_ITER | ELU max | ELU avg | p95 max | p95 min (last 60 s) | 5xx ratio max | pool used max |
|---|---|---|---|---|---|---|
| 300000 | 1.000 | 0.850 | 0.246 | 0.073 | 0.000 | 4 |
| **400000** | 1.000 | 1.000 | 2.468 | 2.435 | 0.000 | 10 |
| 500000 | 1.000 | 1.000 | 2.356 | 2.335 | 0.000 | 10 |
| 650000 | 1.000 | 1.000 | 2.429 | 2.398 | 0.020 | 10 |
| 800000 | 1.000 | 1.000 | 3.545 | 2.812 | 0.000 | 10 |

Criteria (operator): smallest value with ELU ≥ 0.95 **and** p95 ≥ 1.5 s sustained (margin over the 1 s rule so the incident does not resolve mid-fault, as it did in S2 run 1) **and** 5xx ratio < 0.05 (S2 stays latency-only). **400000** is the smallest that meets all three (ELU avg is also 1.0). Its signals match the original pool-lab S2 measurements (p95 2.35–2.43 s, `used` = 10, only the latency rule).

## Proposed change
- `docs/contracts/scenario-db-pool.md` S2: `CPU_ITER=400000`, with a retuning note pointing here. The pool-lab row keeps its measured value (300000) since that is what was measured then.
- `docs/contracts/README.md`: v1.4 line + amendment.
- `apps/demo-service/src/config.ts` default `300000` → `400000` (+ its test), so `run-scenario.ts S2` (which relies on the default) uses the contract value.
- `.claude/skills/scenario-runner/SKILL.md`: the S2 deploy line.
- Unchanged: the S2 fixtures (`packages/contracts/fixtures/S2/manifest.json` records the 300000 lab capture, which is historical fact); `packages/contracts/src` has no `CPU_ITER` constant.

## Affected sessions
A (demo-service default). No other session reads `CPU_ITER`.
