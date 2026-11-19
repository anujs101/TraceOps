# Eval: round 2 (harness + enforcement), 2026-11-19

Code: main `fa37124` (contracts v1.5, round-2 merge). Provider `deepseek` (model `deepseek-flash`). Sequential and unattended under `caffeinate -i`, 17:40–19:27Z. No code changes between runs. The driver, collector, table script and log are in [`eval-20261119T174051Z/`](eval-20261119T174051Z/). Each run dir holds summary, report, evidence and llm_calls, all scanned for keys.

## Raw table
| run | scenario | valid | baseline covered | top hypothesis | confidence | validation | grade | grade if validation had passed | tokens | query_metric |
|---|---|---|---|---|---|---|---|---|---|---|
| `s1-20261119T174053Z` | S1 | yes | yes | db_pool_exhaustion | high | passed | correct | correct | 57,508 | 8 ok / 1 refused |
| `s1-20261119T175525Z` | S1 | yes | yes | db_pool_exhaustion | high | passed | correct | correct | 53,041 | 8 ok / 1 refused |
| `s1-20261119T181515Z` | S1 | yes | yes | db_pool_exhaustion | high | failed (22×V3) | invalid | correct | 55,597 | 8 ok / 1 refused |
| `s2-20261119T183517Z` | S2 | yes | yes | db_pool_exhaustion | high | failed (19×V3) | invalid | misattributed | 54,308 | 8 ok / 1 refused |
| `s2-20261119T185248Z` | S2 | yes | yes | db_pool_exhaustion | high | failed (24×V3, 1×V5) | invalid | misattributed | 50,281 | 8 ok / 3 refused |
| `s2-20261119T191005Z` | S2 | yes | yes | cpu_saturation | high | failed (17×V3) | invalid | correct | 51,979 | 8 ok / 3 refused |

- **S1:** 2/3 valid runs graded correct (3 runs, 0 invalid)
- **S2:** 0/3 valid runs graded correct (3 runs, 0 invalid)

Grades come from `gradeRun` (`packages/contracts/src/grading.ts`). An invalid run is not graded. "Grade if validation had passed" is shown only for diagnosis; it does not count.

## Pass rate per scenario
- **S1: 2/3** (all 3 runs valid). Run 3 had the right hypothesis but failed validation after the repair round (21 bare numbers + 1 unused key).
- **S2: 0/3** (all 3 runs valid). All three failed validation on bare numbers. Even if they had validated, 2 would be misattributed (decoy `db_pool_exhaustion` on top) and 1 correct (`s2-20261119T191005Z`, `cpu_saturation` high).

## Run facts (all 6)
- `scenarioValid` passed, the derived baseline window was covered by healthy 1.0.0 traffic, and the incident resolved normally (30–105 s, no DB edits).
- 0 LLM errors, 7 LLM calls per run (6 in S2 run 2), detection to report 30–35 s, 0 log-hygiene hits.
- Tokens per run were 50–58k, 322,714 in total.
- Machine load (1 min) was 2–4, except S1 run 3 (~7–9).

## Observations (recorded, not acted on)
- **Bare numbers are the only validation blocker.** Runs 3–6 failed validation with 17–24 unbound quantities each, mostly in timeline events and observations. S2 run 2 also had 1×V5. The new repair hints were sent each time (one repair round per run), but the reports still failed.
- **The metric cap holds, but refused calls use up the log reserve.**
  - Every run stopped at 8 ok query_metric calls, and the model kept asking for more (1–3 refused per run).
  - Refused calls count toward the 12, as v1.5 specifies, so the calls left for log tools shrank.
  - In `s2-20261119T191005Z`, 8 ok + 3 refused metric calls plus 1 log_volume took all 12 calls, so all 3 log calls were refused.
  - Every run had at least one log call refused by the global budget.
- **S2 onsets.** In runs 1 and 2, pool, pending, event-loop delay and utilisation all started at the same 5 s step. The run graded correct-if-validated (`…191005Z`) is the only one where `eventloop_utilization` started one step (5 s) earlier than everything else, and the model queried it.
- **Validator false positive.** In S1 run 3, the text "(version 1.0.1)." yields the token `1.0.1)`, which is counted as an unbound quantity (`packages/contracts/src/quantities.ts`: `)` is stripped before the trailing `.`). Without it the report would still have failed on 21 other bare numbers.
