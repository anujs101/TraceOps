# Contract: TraceOps persistence, job queue and state machines

**Status:** frozen v1 (2026-11-17) · Database `traceops` (same Postgres container as `demo`, see `environment.md`). Telemetry is queried live and never copied here. Only evidence the investigator actually saw is stored.
**Time:** columns are `timestamptz`. Every value leaving the database (API, evidence, reports) is serialised as IsoUtcMs.

## 1. Tables
| Table | Key columns | Notes |
|---|---|---|
| `incidents` | `id`, `fingerprint`, `service`, `group`, `status`, `severity`, `started_at`, `detected_at`, `resolved_at`, `reopen_count`, `trigger jsonb` | partial unique index `(fingerprint) WHERE status='open'` |
| `investigation_jobs` | `id`, `incident_id`, `idempotency_key UNIQUE`, `status`, `attempts`, `max_attempts=2`, `lease_until`, `last_error`, `created_at`, `updated_at` | queue |
| `investigations` | `id`, `incident_id`, `job_id`, `status`, `trigger` (`auto`/`manual`), `model`, `started_at`, `finished_at`, `tool_calls`, `cancel_requested`, `error` | one per attempt or run |
| `evidence` | per `evidence-and-report.md` §1; unique `(investigation_id, id)` | append-only |
| `reports` | `investigation_id PK`, `report jsonb`, `validation` (`passed`/`failed`), `violations jsonb`, `warnings jsonb`, `repair_attempted` | |
| `llm_calls` | `id`, `investigation_id`, `turn`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `latency_ms`, `stop_reason`, `created_at` | cost and latency source |
| `scenario_runs` | `id`, `scenario` (`S1`/`S2`), `incident_id`, `signal_summary jsonb`, `valid`, `invalid_reasons jsonb`, `started_at`, `ended_at` | evaluation; see `scenario-db-pool.md` |

## 2. Job queue (PostgreSQL, no Redis)
```sql
UPDATE investigation_jobs SET status='running', attempts=attempts+1,
       lease_until=now()+interval '5 minutes', updated_at=now()
WHERE id = (SELECT id FROM investigation_jobs
            WHERE status='queued' OR (status='running' AND lease_until < now())
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```
- Heartbeat extends the lease every 30 s. The investigation budget (3 min) is shorter than the lease (5 min).
- Idempotency: `incident:<id>:auto`; manual re-run `incident:<id>:manual:<uuid>`; `ON CONFLICT DO NOTHING`.
- **Retry only infrastructure failures** (LLM 429/5xx after SDK retries, DB errors, crash). Each attempt is a new `investigations` row. After 2 attempts the job is `dead`.
- `validation: failed` and `insufficient_evidence` are **completed** investigations, never retried.
- The idle worker polls every 1 s.

## 3. State machines
- **Job:** `queued → running → done | failed`; `failed → queued` while attempts < max, else `dead`.
- **Investigation:** `running → completed | failed | cancelled`. `completed` ⇒ a `reports` row exists. `cancel_requested` is checked before each model turn and each tool call.
- **Incident:** `open ⇄ resolved` (reopen within `reopen_window_s`).

## 4. Retention
Keep everything (local demo). Production would need retention and access control, because evidence holds redacted log text.
