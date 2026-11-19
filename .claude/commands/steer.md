---
description: Log a steering correction to this branch's build log
argument-hint: "<what you corrected and why>"
allowed-tools: Bash(git rev-parse:*), Bash(date:*), Bash(mkdir:*)
---
The user is correcting you. Log it, then act on it.

1. Branch = `git rev-parse --abbrev-ref HEAD`, with `/` replaced by `-`. File = `docs/build-log/<branch>.md` (create it with a `# Build log: <branch>` heading if missing).
2. Append one line:
   `- <date -u +%Y-%m-%dT%H:%MZ> · was doing: <one short clause, your own words> · correction: $ARGUMENTS`
   The correction is the user's words **verbatim**. Don't soften, reword or justify.
3. Show the appended line. Then apply the correction to your current work.
