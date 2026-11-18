# Contract: TraceOps persistence, job queue and state machines

**Status:** v1.1 (2026-11-18; `llm_calls` amended, everything else unchanged from frozen v1) · Database `traceops` (same Postgres container as `demo`, see `environment.md`). Telemetry is queried live and never copied here. Only evidence the investigator actually saw is stored.
**Time:** columns are `timestamptz`. Every value leaving the database (API, evidence, reports) is serialised as IsoUtcMs.

## 1. Tables
| Table | Key columns | Notes |
|---|---|---|
| `incidents` | `id`, `fingerprint`, `service`, `group`, `status`, `severity`, `started_at`, `detected_at`, `resolved_at`, `reopen_count`, `trigger jsonb` | partial unique index `(fingerprint) WHERE status='open'` |
| `investigation_jobs` | `id`, `incident_id`, `idempotency_key UNIQUE`, `status`, `attempts`, `max_attempts=2`, `lease_until`, `last_error`, `created_at`, `updated_at` | queue |
| `investigations` | `id`, `incident_id`, `job_id`, `status`, `trigger` (`auto`/`manual`), `model`, `started_at`, `finished_at`, `tool_calls`, `cancel_requested`, `error` | one per attempt or run |
| `evidence` | per `evidence-and-report.md` §1; unique `(investigation_id, id)` | append-only |
| `reports` | `investigation_id PK`, `report jsonb`, `validation` (`passed`/`failed`), `violations jsonb`, `warnings jsonb`, `repair_attempted` | |
| `llm_calls` | **v1.1**, see §1a | one row per provider **attempt**; cost, latency and error source |
| `scenario_runs` | `id`, `scenario` (`S1`/`S2`), `incident_id`, `signal_summary jsonb`, `valid`, `invalid_reasons jsonb`, `started_at`, `ended_at` | evaluation; see `scenario-db-pool.md` |

## 1a. `llm_calls` (v1.1, provider-neutral)
**Executable source:** `LlmCall` in `packages/contracts/src/llm.ts`. The app maps records with `toLlmCallRow()`.

All v1 columns are kept. v1.1 adds columns and relaxes nullability; nothing is removed or renamed.
- **Keys:** a row is one provider **attempt**. Retries are separate rows, keyed by `(investigation_id, turn, attempt)`.
- **`turn`:** numbers the logical model requests within an investigation, first the `investigate` turns, then the `report` rounds.
- **`created_at`:** when the attempt started.
- **Failed calls:** recorded with `status = 'error'`, an `error_kind`, and NULL tokens.
- **Missing usage:** if a successful call reports no usage, the tokens are NULL, never 0.
- **Never stored:** prompts, model outputs (those live in `evidence` and `reports`), headers or keys.

```sql
CREATE TABLE llm_calls (
  id                uuid PRIMARY KEY,
  investigation_id  uuid NOT NULL REFERENCES investigations(id),
  turn              int  NOT NULL CHECK (turn >= 1),
  attempt           int  NOT NULL CHECK (attempt >= 1),                    -- v1.1
  provider          text NOT NULL,                                         -- v1.1  ('groq')
  model             text NOT NULL,
  stage             text NOT NULL CHECK (stage IN ('investigate','report')),           -- v1.1
  kind              text NOT NULL CHECK (kind IN ('chat','structured')),               -- v1.1
  status            text NOT NULL CHECK (status IN ('ok','error')),                    -- v1.1
  request_id        text NULL,                                             -- v1.1
  input_tokens      int  NULL CHECK (input_tokens >= 0),                   -- v1.1: now nullable
  output_tokens     int  NULL CHECK (output_tokens >= 0),                  -- v1.1: now nullable
  cache_read_tokens int  NULL CHECK (cache_read_tokens >= 0),              -- v1.1: now nullable (Groq: NULL)
  latency_ms        int  NOT NULL CHECK (latency_ms >= 0),
  stop_reason       text NULL CHECK (stop_reason IN ('tool_calls','end','length','other')),
  tool_call_count   int  NULL,                                             -- v1.1
  error_kind        text NULL,                                             -- v1.1  (LLM_ERROR_KINDS)
  error_status      int  NULL,                                             -- v1.1  (HTTP status)
  error_message     text NULL CHECK (char_length(error_message) <= 300),   -- v1.1  (redacted)
  retry_after_ms    int  NULL,                                             -- v1.1
  provider_timings  jsonb NULL,                                            -- v1.1  (e.g. Groq queue/prompt/completion ms)
  created_at        timestamptz NOT NULL,
  UNIQUE (investigation_id, turn, attempt),
  CHECK (status = 'error' OR (error_kind IS NULL AND stop_reason IS NOT NULL)),
  CHECK (status = 'ok' OR (error_kind IS NOT NULL AND input_tokens IS NULL AND output_tokens IS NULL))
);
CREATE INDEX llm_calls_investigation ON llm_calls (investigation_id, turn);
```
No migration exists yet, because there's no database code. This DDL is the first `llm_calls` migration the investigator build writes.

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
