# Proposal: a reopened incident never gets investigated

**Status:** proposal only, nothing implemented. Raised by session C (`session/C-detector`) while building the detector.
**Touches:** `docs/contracts/detection.md` §4 and §6, `docs/contracts/persistence.md` §2 (idempotency keys). All frozen.

## Problem
`detection.md` §4 says an incident reopens when it fires again within `reopen_window_s` (`reopen_count++`), and that open + enqueue use the job key `incident:<id>:auto`. A reopen keeps the same incident id, so the key is the one the first investigation already used. With `ON CONFLICT DO NOTHING` the enqueue is silently a no-op: **a reopened incident never triggers an investigation.**

The same reopen also keeps `started_at` and `detected_at` from the first episode, and `deriveWindows` (§6) builds every window from `started_at`. A reopened episode that fires a few minutes after the first one resolved would be investigated, if it were investigated at all, with an `incident` window that starts before the first episode and spans the quiet gap, and a baseline that sits inside the first episode.

## Evidence
`apps/traceops/test/detector/detector.test.ts`, "firing again within the window reopens the SAME incident": after resolve at tick 5 and a re-fire at tick 11 (~90 s later) the incident is `open`, `reopen_count = 1`, `started_at` unchanged, and `investigation_jobs` still holds exactly **one** row (the original, already consumed). The test pins the contract-literal behaviour so any change to it is deliberate.

Why it matters for evaluation: repeated runs of S1/S2 against the same service and group (N=5 evaluation) share one fingerprint (`sha256("demo-service:http-slo")`). Any run whose fault fires within `reopen_window_s` (default 300 s) of the previous run's resolve reopens the old incident and produces **no investigation**, so a batch silently yields fewer investigations than runs, with nothing in the output saying why. I have not run this live; the claim rests on the test above and on the contract text.

## Options
**A. New job per reopen.** Key `incident:<id>:reopen:<reopen_count>` instead of reusing `:auto`. Still idempotent (a retried transaction repeats the same count), one investigation per episode. Contract change in `detection.md` §4 and the `persistence.md` §2 key list. Windows stay wrong (see Problem) unless combined with B.

**B. Reopen starts a new episode window.** On reopen also set `started_at` and `detected_at` to the new episode's values, so `deriveWindows` sees the new episode. Loses the original start time unless a column such as `first_started_at` is added (schema change). Only meaningful together with A.

**C. Evaluation config only, no contract change.** Run evaluation with `reopen_window_s: 0`. Then no resolved incident is ever recent enough to reopen, every fire opens a new incident with its own `:auto` job and its own windows, and N=5 behaves as expected. `reopen_window_s` is already a config value (`RuleConfig` allows 0). Cost: flapping in that environment produces separate incidents instead of reopens, which is acceptable for a scripted evaluation but not a statement about production behaviour.

**D. Leave as is.** Reopen means "same problem recurred; the earlier investigation still applies", and a person can start a manual re-run (`incident:<id>:manual:<uuid>`). Defensible for production, but wrong for repeated evaluation runs.

## Recommendation
Use **C** now (nothing frozen changes, and evaluation works). Decide separately whether production reopen should be **A + B**; I'd choose A + B if a reopened incident is expected to be investigated, and D if it is expected not to be. This is the main session's call.

## What C does in the meantime
The detector implements the contract literally: reopen enqueues with `incident:<id>:auto`, which conflicts, so nothing is enqueued. No workaround is built in.
