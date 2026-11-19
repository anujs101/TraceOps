---
description: Run typecheck and tests for every workspace and show the raw results
allowed-tools: Bash(npm test:*), Bash(npm run typecheck:*)
---
Prove the current state of the repo. Do not summarise before running.

1. From the repo root run `npm run typecheck 2>&1 | tail -40` and show the output.
2. Run `npm test 2>&1 | grep -E "Test Files|Tests|FAIL|✗|×|Error" ` and show the output. If anything failed, also show the failing test's full output (`npm test -w <workspace> -- <file>`).
3. Report a table: workspace · typecheck (pass/fail) · tests passed/total. Baseline: contracts 110, @traceops/app 96. Flag any drop below baseline.
4. End with exactly one line: `VERIFIED` if everything passed, otherwise `NOT VERIFIED: <reason>`.

Never say a step is done without a `VERIFIED` line from this command in the same turn.
