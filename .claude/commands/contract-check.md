---
description: Confirm this branch has not changed contracts, seams or fixtures
argument-hint: "[base branch, default main]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git merge-base:*)
---
Base branch: `$ARGUMENTS` if given, otherwise `main`.

Run:
```bash
git diff --stat $(git merge-base HEAD <base>) -- packages/contracts docs/contracts apps/traceops/src/seams.ts
git status --short -- packages/contracts docs/contracts apps/traceops/src/seams.ts
```

- Both empty → reply `CONTRACTS UNCHANGED`.
- Anything listed → reply `CONTRACTS CHANGED`, list each file, show its diff, and say whether a matching `docs/proposals/*.md` exists. On a `session/*` branch this is a defect to undo, not to justify.
