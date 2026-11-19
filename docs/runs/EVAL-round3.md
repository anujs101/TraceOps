# Eval: round 3 (refused metric calls not charged, F UI merged), 2026-11-19

Code: main `30046b2`. That is contracts v1.6 (refused query_metric calls are recorded, not charged to the 12) plus the session F UI merge. Provider `deepseek` (model `deepseek-flash`). The runs were sequential and unattended under `caffeinate -i`, 19:57–21:44Z, with no code changes between runs. The driver, collector, table and compare scripts and the log are in [`eval-20261119T195709Z/`](eval-20261119T195709Z/). Each run dir holds summary, report, evidence and llm_calls, all scanned for keys (0 hits).

## Raw table
| run | scenario | valid | baseline covered | top hypothesis | confidence | validation | grade | grade if validation had passed | tokens | query_metric |
|---|---|---|---|---|---|---|---|---|---|---|
| `s1-20261119T195710Z` | S1 | yes | yes | db_pool_exhaustion | high | passed | correct | correct | 65,570 | 8 ok / 2 refused |
| `s1-20261119T201212Z` | S1 | yes | yes | db_pool_exhaustion | high | passed | correct | correct | 60,527 | 8 ok / 1 refused |
| `s1-20261119T203158Z` | S1 | yes | yes | db_pool_exhaustion | high | passed | correct | correct | 59,242 | 8 ok / 2 refused |
| `s2-20261119T205146Z` | S2 | yes | yes | cpu_saturation | high | failed (1×V0) | invalid | correct | 59,311 | 7 ok / 2 refused |
| `s2-20261119T210903Z` | S2 | yes | yes | db_pool_exhaustion | medium | failed (5×V3) | invalid | misattributed | 60,191 | 8 ok / 2 refused |
| `s2-20261119T212636Z` | S2 | yes | yes | db_pool_exhaustion | high | failed (1×V1, 15×V3) | invalid | misattributed | 61,994 | 8 ok / 2 refused |

- **S1:** 3/3 valid runs graded correct (3 runs, 0 invalid)
- **S2:** 0/3 valid runs graded correct (3 runs, 0 invalid)

Grades come from `gradeRun` (`packages/contracts/src/grading.ts`). An invalid run is not graded. "Grade if validation had passed" is shown for diagnosis only and does not count.

## Comparison with round 2
| round | S1 pass | S2 pass | refused log calls (all runs) | refused metric calls | bare-number violations (final reports) |
|---|---|---|---|---|---|
| round 2 (fa37124) | 2/3 | 0/3 | 12 | 10 | 80 |
| round 3 (30046b2) | 3/3 | 0/3 | 9 | 11 | 18 |

The refused-log-call counts mean different things in the two rounds:
- **Round 2:** refused metric calls were charged to the 12, so they used up the log reserve. In one run all 3 log calls were refused.
- **Round 3:** every run executed 4 log calls, so the full reserve survived. The 9 refused log calls all came after 12 charged calls (8 metric + 4 log), as the normal global `budget_exhausted` ("the tool budget is used up"). Evidence rows per run: 14–16, contiguous ids.

## Run facts (all 6)
- `scenarioValid` passed in every run, and healthy 1.0.0 traffic covered the derived baseline window.
- Every incident resolved normally (30–105 s).
- 0 LLM errors, 7–8 LLM calls per run.
- Detection to report: 30–34 s.
- Log-hygiene hits: 0.
- Tokens per run: 59–66k (366,835 in total), about 15% more per run than round 2 (the extra log-tool output).
- Machine load (1 min): 3–5, except S1 run 1 (~7).

## Observations (recorded, not acted on)
- **S1 is now 3/3.** All three runs passed validation with `db_pool_exhaustion` high.
- **Bare numbers dropped (80 → 18) but still block S2.**
  - S2 run 2 has 4 unbound quantities and 1 unused key; S2 run 3 has 14 unbound and 1 unused.
  - Run 3 also cites `ev_14`, which came back `empty`, in a timeline item (1×V1).
- **New failure type: summary too long.** S2 run 1 had the right answer (`cpu_saturation` high) but failed only on V0: the summary was 605 chars against the 600 limit. The repair round did not shorten it.
- **S2 attribution:** 1 of 3 runs would have been correct if validated (the same as round 2). The other two put the decoy `db_pool_exhaustion` on top.
- **S2 onsets still tie:** in all three runs, pool_used, pool_pending, event-loop delay and utilisation start at the same 5 s step (docs/known-gaps.md, "Evaluation design (S2)").
