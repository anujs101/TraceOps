# Overnight job, 2026-11-19/20 (unattended)

All times are local (UTC+5:30). Nothing was pushed. Every decision is also logged in `docs/build-log.md`.

## What ran and what merged
| step | result | commits |
|---|---|---|
| 0. Fallback tag | `eval-round2` → `ad8654d` (main at the end of round 2) | tag only |
| 1. Refused metric calls not charged | Contracts v1.6: tools.md §1, the README amendment and `docs/proposals/tools-budget-refusals.md`, all on `contracts/tools-budget-refusals`. The runtime change and tests are on `fix/budget-refusals`. /verify was green on each branch, and both merged `--no-ff`. | `16205b7`, `2e82387`; merges `fc25081`, `f135383` |
| 2. Session F UI | The handoff was already on `session/F-ui` (`4f0a872`) at the first check, so there was no wait. contract-guardian: MERGEABLE, 0 blockers. /code-review: 4 important + 4 nits. I fixed 3 real blockers on `fix/F-ui` and merged `--no-ff`. No deps changed, so the lockfile was not regenerated. | `d09ca19`; merge `30046b2` |
| 3. Eval round 3 | S1 ×3, S2 ×3 on `30046b2`, sequential, under `caffeinate -i`, 01:27–03:14 local (19:57–21:44Z). 6/6 valid, 0 aborts, 0 key hits. | run dirs + [`EVAL-round3.md`](EVAL-round3.md) |
| 4–5. Reports | This file plus the build-log lines | committed together with the eval results |

### The F-ui blockers fixed (d09ca19)
1. In-page anchors (validation strip, "All evidence") changed the hash and routed to the incident list. They now scroll in place (`apps/web/src/lib/jump.ts`, and `useHash` ignores non-route hashes).
2. "Run a new investigation" never showed the new run. The incident page now polls every 2 s until a new row appears, for at most 2 min.
3. Prose "hypothesis N" didn't match the card numbering. Prose now uses the card's rank/position.

Each fix has a test (web 45 → 48).

### Review findings NOT fixed (left for F/D, not blockers)
- **Incident list loads all-or-nothing:** it uses `Promise.all`, so one failing report hides the whole list.
- **App-wide polling cost:** the incident summary is polled across the whole app.
- **Chart shading:** shading is drawn even when there is no baseline/incident split.
- **TimeRuler:** no guard for an empty input.
- **`VITE_API_TARGET`:** not read from `.env`.
- **Dev API on :4100 loads unvalidated run summaries:** new runs lack `incident.service` and `investigation.model`.
- **Guardian notes:**
  - `BoundValue` is redeclared.
  - The vite proxy uses `localhost` where it should be `127.0.0.1`.
  - The new dev env vars are undocumented.
  - The Rail shows `tool_calls` where it should show `evidence.length`. Since v1.6 these can differ (14–16 rows vs 12 charged calls).
  - Proposal `validator-timeline-placeholders.md` needs triage.

## What failed
- **Nothing in the pipeline failed.** No branch was left unmerged and no eval run aborted.
- **S2 is still 0/3** (it was 0/3 in round 2 as well). All three S2 reports failed validation:
  - S2 run 1 had the right top hypothesis (`cpu_saturation` high). It failed only because the summary was 605 chars against the 600 limit (V0).
  - The other two put the decoy on top and also had bare numbers.
- **The skipped plan-mode approval was a deliberate skip** (CLAUDE.md rule 7), because the job said to be unattended and not to ask. It is logged.

## Round 3 vs round 2
| round | S1 pass | S2 pass | refused log calls (all runs) | refused metric calls | bare-number violations (final reports) |
|---|---|---|---|---|---|
| round 2 (fa37124) | 2/3 | 0/3 | 12 | 10 | 80 |
| round 3 (30046b2) | 3/3 | 0/3 | 9 | 11 | 18 |

- **Log calls:** in round 3 every run executed all 4 reserved log calls. The 9 refused log calls are ordinary global-budget refusals, made after 12 charged calls.
- **Details:** see [`EVAL-round3.md`](EVAL-round3.md).

## Final /verify (main `30046b2`, `TRACEOPS_DATABASE_URL` set inline, 03:16 local)
```
> @traceops/contracts typecheck   tsc --noEmit   (clean)
> @traceops/demo-service typecheck tsc --noEmit  (clean)
> @traceops/app typecheck          tsc --noEmit  (clean)
> @traceops/web typecheck          tsc --noEmit  (clean)
 Test Files  5 passed (5)
      Tests  115 passed (115)
 Test Files  2 passed (2)
      Tests  16 passed (16)
 Test Files  28 passed (28)
      Tests  590 passed (590)
 Test Files  5 passed (5)
      Tests  48 passed (48)
```
| workspace | typecheck | tests |
|---|---|---|
| contracts | pass | 115/115 |
| demo-service | pass | 16/16 |
| @traceops/app | pass | 590/590 |
| web | pass | 48/48 |

0 skipped. VERIFIED.

## Recording: use new main, not `eval-round2`
**Recommendation: record on `30046b2`.** That is the code commit. The eval-docs commit made right after this file changes only `docs/runs/` and `docs/build-log.md`. Tag it yourself if you want to: `git tag recording 30046b2`. I did not create the tag, because the job didn't ask for it.

Reasons:
- **S1 is 3/3 validated-correct on this code**, compared with 2/3 on `eval-round2`. The S1 happy path is what the recording shows end to end.
- **It has the session F UI v2** with the three flow fixes: in-page evidence links, rerun showing the new run, and prose labels matching the cards. `eval-round2` has the old UI.
- **The log reserve now survives** (4 log calls in every run), so the evidence ledger shows logs as well as metrics.
- **S2 is no worse:** 0/3 on both, with 1 correct-if-validated on both. S2 is not a reason to prefer the older tag.

Keep `eval-round2` as the fallback. Use it only if the new UI shows a problem during the dry run. The unfixed review items above are cosmetic or affect only the dev API.
