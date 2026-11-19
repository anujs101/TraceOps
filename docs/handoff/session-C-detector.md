# Handoff: session/C-detector (commits bd84cc9, 9b9c508, a1ed48f, + review-fix commit)

## Done and verified (`/verify`, 2026-11-19, DB URL inline, 0 skipped)
- Typecheck pass (contracts, app). Tests: contracts 110/110, app 206/206 (baseline 96; +110 incl. review-fix tests).
- DB, detector and queue suites ran against postgres:18.6 (`c-pg`, :5433); without `TRACEOPS_DATABASE_URL` they skip loudly (a skip is not a pass).
- Mutation checks caught: resolve_after hysteresis (8 tests), post-claim dead check, SKIP LOCKED (behavioural test).
- `/contract-check`: CONTRACTS UNCHANGED vs merge-base(main).

## Done, not verified
- No live run against real Prometheus/Loki or a live S1/S2 (detector only saw fixture-derived responses; fixtures are range captures turned into instant vectors).
- `Detector.start()` cadence over real time (interval_s is fixed at 15) is not tested beyond one immediate tick plus stop.
- `/code-review` and `contract-guardian` reviewed; items 1–6 + 2 nits fixed (see "Review fixes"). Reopen / `:auto` key left to main (Wave 2).

## Not done
- All four Build steps are done. Out of scope and absent: entry point/wiring, HTTP API, investigator, retention, any use of `scenario_runs` (table exists, no code).

## Deviations and proposals
- Proposal: `docs/proposals/detection-reopen-job-key.md` (reopen reuses `incident:<id>:auto`, so no re-investigation; decision deferred to Wave 2, config keeps `reopen_window_s: 300`).
- Behaviours added beyond the contract, for contract-guardian:
  - Restart: groups with an open incident start their rules as `recovering(0)` (`seedFromOpenIncidents`, called by `start()`).
  - A failed incident write is "owed" and retried next tick. An owed open is kept until written, even if its rule has moved to recovering/ok; if the group recovered first it opens (detected_at = the fire tick) and then resolves.
  - Resolve is attempted only after a rule transitions to `ok` and every rule in the group is `ok`.
  - Severity `critical` iff every rule in the group reached `firing` during the episode (§5). Update merges `trigger` by `rule_id` and never downgrades severity while open. Rules seeded `recovering(0)` on restart do not count as fired.
  - Reopen keeps the original `started_at`/`detected_at`; its `:auto` enqueue conflicts and is a no-op.
  - More than one series in an instant result counts as missing data (`ambiguous`).
  - Worker: job claimed with `attempts > max_attempts` is marked dead, handler not run (approved). Handler resolving = done; throwing = infra failure (requeue, then dead). `failed` is never persisted (one UPDATE).
  - DDL beyond §1a (not given verbatim): extra CHECKs (incident status/`resolved_at` consistency, job/investigation status, evidence id regex), evidence `window_start`/`window_end` columns, nullable `scenario_runs.incident_id`.
  - Store extras beyond the seam: `createInvestigation`, `finishInvestigation` (rejects `completed` without a report), `insertLlmCall`/`insertLlmCallRow`; `reportSink.save` upserts; evidence listed in numeric id order.
  - Migration runner: `schema_migrations` table plus advisory lock.

## Review fixes (this commit)
- Lease tied to the claim: `heartbeat`/`completeJob`/`failJob`/`markDead` take `attempts` and require `AND attempts = $n` (signature change; no callers outside `queue/`). Claim SQL unchanged.
- Worker bookkeeping (`completeJob`/`failJob`) retried 3× with backoff (`retryBaseMs`), then an `error` log; never rejects. `stop()` no longer waits a full `pollMs`.
- `prom-client`: null / non-string / empty sample is missing data (never 0); abort while reading the body is `timeout`.
- `incidents.ts` types come from `Incident['trigger'][number]` / `Incident['severity']`. `Detector.start()` resets `stopped` if seeding throws.

## How to run it
- `export TRACEOPS_DATABASE_URL=postgres://traceops:traceops@localhost:5433/traceops` (do not write it to a file)
- `npm run migrate -w @traceops/app` · `npm run typecheck` · `npm test`
- `docker run -d --name c-pg -p 5433:5432 -e POSTGRES_USER=traceops -e POSTGRES_PASSWORD=traceops -e POSTGRES_DB=traceops postgres:18.6`

## For the integrator
- `apps/traceops/package.json` adds `pg`, `yaml`, `@types/pg` and the `migrate` script. Root `package-lock.json` is NOT committed: regenerate with `npm install`. The lockfile in this worktree listed the rolldown darwin-arm64 binding once (vs 3 at HEAD); vitest only started after `npm install --no-save @rolldown/binding-darwin-arm64@1.2.19`.
- Wire in main: run `migrate`, then `new Detector({config: loadRuleConfig(), pool, prometheusUrl}).start()` and `new Worker({pool, handler}).start()`. Env is not read by these modules; only `createPool()` reads `TRACEOPS_DATABASE_URL`.
- The worker handler (D's investigator) must create `investigations` via `PgInvestigationStore.createInvestigation` and call `finishInvestigation`; the store implements the frozen `InvestigationStore` seam.
- Container `c-pg` is left running on 5433 as requested: `docker rm -f c-pg` when done.
