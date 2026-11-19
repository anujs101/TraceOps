---
description: Write a short status note for this branch before merge or /clear
allowed-tools: Bash(git rev-parse:*), Bash(git status:*), Bash(git log:*), Bash(git diff:*), Bash(npm test:*), Bash(npm run typecheck:*)
---
Write `docs/handoff/<branch with / replaced by ->.md` (overwrite it) with these sections, each a few bullets:

- **Done and verified:** with the `/verify` result (run it now if not run this turn).
- **Done, not verified:** and why it couldn't be verified.
- **Not done:** remaining items from the spec's Build list.
- **Deviations and proposals:** links to any `docs/proposals/*.md`, or "none".
- **How to run it:** the exact commands.
- **For the integrator:** anything the main session must know to merge or wire this branch.

Keep it under 40 lines. Facts only: nothing you haven't seen pass is "verified".
