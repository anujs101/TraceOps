# Proposal: redact provider account ids in `llm_calls.error_message`

**From:** session D (investigator) · **Severity:** low (not a secret, but account metadata reaches storage and the UI) · 2026-11-19

## Problem
Groq 429 messages contain the organization id, e.g.
`Rate limit reached for model ... in organization \`org_01…\` service tier \`on_demand\` ...`
(first live investigation run, 2026-11-19 12:09). `RecordingProvider` (`apps/traceops/src/llm/recorder.ts`)
stores `errorMessage` through `redactSecrets()` (`src/llm/errors.ts`), which strips keys and bearer
tokens but not `org_…` ids. Those rows become `llm_calls.error_message` (persistence.md §1a), and the UI
shows model calls.

## What D already does (own paths only)
- `investigations.error`: `describeError()` in `src/investigator/investigate.ts` applies `redactAccountIds()`.
- `live-run.ts` redacts `error_message` before printing or saving, and its output scan rejects any unredacted `org_` id.

The worker (main session) writes `llm_calls` rows directly from the recorder, so the column is still unredacted there.

## Proposed change (main session or LLM-layer owner)
Add `.replace(/\borg_[A-Za-z0-9]+/g, 'org_[REDACTED]')` to `redactSecrets()` in `src/llm/errors.ts`, plus a test.
The DeepSeek adapter (session E) should check whether its error bodies carry similar identifiers.
