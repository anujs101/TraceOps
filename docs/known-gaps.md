# Known gaps (Wave 2, after the first live S1 run)

These are recorded and not fixed. Each one is either a deliberate deferral or waits on a decision.

## Evaluation tooling
- **The scenario runner overwrites a tracked file.** `apps/demo-service/scripts/run-scenario.ts` writes `apps/demo-service/runs/S1-summary.json` (and `S2-summary.json`). `S1-summary.json` is session A's committed acceptance evidence, and each live run overwrites it (first seen on 2026-11-19; restored with `git checkout`). The runner should write to a timestamped path, for example `runs/S1-<UTC>-summary.json`, and leave the committed evidence alone. For now, run records go to `docs/runs/s1-<UTC>/`. After each run, restore A's file with `git checkout apps/demo-service/runs/S1-summary.json`.

## Detector (session C)
- **Restart severity.** After a detector restart, a merged trigger can cover every rule in the group while severity stays `warning` (`apps/traceops/src/detector/incidents.ts`, detection.md §5).
- **Reopen job key.** A reopened incident reuses `incident:<id>:auto`, so it is never investigated again (`docs/proposals/detection-reopen-job-key.md`).

## Worker / queue (session C)
- **Stale handler after a lost lease.** The worker does not abort a handler whose lease was lost, so a reclaim can run it concurrently. The job handler closes the stale investigation row as `failed('worker_lost')` on reclaim, but not the concurrent writes.

## Tools (session B)
- **Step size.** Windows of 59–60 min get a step over 60 s, so `log_volume` sums under-count and `query_metric` samples `rate[1m]` at 75 s (`docs/proposals/tools-step-size.md`).
- **Timeout retries.** Backend timeouts are retried as network errors (tools.md §1 says "network error"), so the worst case is about 10 s per call.

## LLM layer
- **`<tool_data call_id>` vs `evidence_id`.** The wrapper attribute differs from tools.md §1. It is cosmetic, because every output carries `evidence_id` (`docs/proposals/investigator-tool-data-wrapper.md`).
- **DeepSeek in the contract.** environment.md §6 "DeepSeek specifics" is still marked open: the structured mode (a forced strict `submit_report` tool), the error mapping and the confirmed model id need a `contracts/*` amendment. DeepSeek error codes have not been seen live.

## Demo service (session A)
- **`POST /orders` connection leak outside the fault.** If the stock-check query throws, the client is never released, under every `FAULT` value (`apps/demo-service/src/app.ts`). Fix this before S2 or evaluation runs.

## Evaluation design (S2)
- **S2's distinguishing signal comes after the investigation.** scenario-db-pool.md names "the pool recovers when load drops" as the S1/S2 discriminator. The load drop happens ≥ 3 min after detection, but the investigation finishes ~36 s after detection (`docs/runs/s2-20261119T144936Z`), so the investigator can never observe recovery.
- **Onsets tie at 5 s resolution.** At `CPU_ITER=400000`, `pool_used`, `pool_pending`, `eventloop_delay_p99` and `eventloop_utilization` all leave baseline at the same 5 s step (14:54:22 in `s2-20261119T144936Z`), with latency, `pool_wait_p95` and `db_operation_p95` one step later. Onset order alone cannot separate cause from effect; only utilisation-vs-queueing can.
- **Tier 2 idea (not built):** a follow-up investigation after recovery (or after the load drop) that re-checks the open hypotheses against what recovered and what did not.
