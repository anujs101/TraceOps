# Spec C: detector, job queue, database

**Branch:** `session/C-detector` · **Owns:** `apps/traceops/src/{detector,queue,db}/`, `apps/traceops/config/`, `apps/traceops/test/{detector,queue,db}/` (+ dependency additions in `apps/traceops/package.json`)

## 1. Goal
Deterministic symptom detection that opens incidents and enqueues investigation jobs in one transaction, a Postgres job queue with leases, and the `traceops` schema with an implementation of `InvestigationStore`.

## 2. Owns
The paths above. Everything else is read-only.

## 3. Contracts
- `detection.md` all sections: `config/rules.yaml` (validated by `RuleConfig`), rule state machine, missing-data handling, fingerprint, open/resolve/reopen, incident record.
- `persistence.md` all sections: every table, partial unique index, `llm_calls` DDL exactly as written (§1a), the claim query (§2), heartbeat, idempotency keys, retry rules, state machines.
- `environment.md` §4: `TRACEOPS_DATABASE_URL`, `PROMETHEUS_URL`.

## 4. Inputs
- `@traceops/contracts`: `RuleConfig`, `Incident`, `METRIC_TEMPLATES` (`latency_p95`, `error_ratio_5xx`), `LlmCall`, `toIsoUtcMs`.
- `src/seams.ts`: `InvestigationStore`, `InvestigationRow`, `EvidenceSink`. `src/report/generate.ts`: `ReportRow`. `src/llm/recorder.ts`: `toLlmCallRow`.
- `packages/contracts/fixtures/S1/prom-latency_p95.json`, `prom-error_ratio_5xx.json`, `prom-empty.json` for detector tests.

## 5. Build
1. `src/db/migrations/`: plain SQL, numbered, applied by a small runner (`npm run migrate`). `src/db/pool.ts`. Use `pg`.
2. `src/db/store.ts`: `InvestigationStore` over Postgres; all times out as IsoUtcMs.
3. `src/detector/`: instant queries (`/api/v1/query`) every `interval_s`, the per-rule state machine, incident open + enqueue in one transaction, resolve and reopen.
4. `src/queue/`: enqueue (`ON CONFLICT DO NOTHING`), claim (the exact §2 query), heartbeat every 30 s, complete/fail/dead, worker loop polling every 1 s that calls an injected handler `(job) => Promise<void>`.

## 6. Acceptance (show the output)
- `npm test -w @traceops/app` and typecheck pass; baseline tests still pass.
- State machine tests: `ok → pending → firing → recovering → ok`; breach while recovering → firing; missing data → no transition; never resolves on missing data.
- Against a real local Postgres (`infra/compose.yml` may not exist yet: use any local Postgres via `TRACEOPS_DATABASE_URL`; skip DB tests with a clear message if unset): duplicate open incident impossible; two concurrent claims never get the same job; expired lease is reclaimed; attempts > 2 → `dead`; `llm_calls` CHECK constraints reject an `ok` row with an `error_kind`.
- `toLlmCallRow()` output inserts without error.

## 7. Out of scope
The investigator, tools, HTTP API, UI, LLM calls, any LLM in detection, Redis, retention.

## 8. Stop conditions
The DDL in `persistence.md` can't be applied as written, or a rule can't be expressed with `RuleConfig` → stop and write `docs/proposals/persistence-<topic>.md`.
