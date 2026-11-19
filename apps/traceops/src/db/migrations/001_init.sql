-- persistence.md §1 (v1.1). Times are timestamptz; the app serialises them as IsoUtcMs.

CREATE TABLE incidents (
  id            uuid PRIMARY KEY,
  fingerprint   text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  service       text NOT NULL,
  "group"       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('open','resolved')),
  severity      text NOT NULL CHECK (severity IN ('critical','warning')),
  started_at    timestamptz NOT NULL,
  detected_at   timestamptz NOT NULL,
  resolved_at   timestamptz NULL,
  reopen_count  int NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  "trigger"     jsonb NOT NULL,
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL))
);
-- a duplicate open incident for one fingerprint is impossible
CREATE UNIQUE INDEX incidents_one_open_per_fingerprint ON incidents (fingerprint) WHERE status = 'open';
CREATE INDEX incidents_fingerprint_resolved ON incidents (fingerprint, resolved_at);

CREATE TABLE investigation_jobs (
  id               uuid PRIMARY KEY,
  incident_id      uuid NOT NULL REFERENCES incidents(id),
  idempotency_key  text NOT NULL UNIQUE,
  status           text NOT NULL CHECK (status IN ('queued','running','done','failed','dead')),
  attempts         int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     int NOT NULL DEFAULT 2 CHECK (max_attempts >= 1),
  lease_until      timestamptz NULL,
  last_error       text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX investigation_jobs_claim ON investigation_jobs (status, created_at);

CREATE TABLE investigations (
  id                uuid PRIMARY KEY,
  incident_id       uuid NOT NULL REFERENCES incidents(id),
  job_id            uuid NULL REFERENCES investigation_jobs(id),
  status            text NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  "trigger"         text NOT NULL CHECK ("trigger" IN ('auto','manual')),
  model             text NOT NULL,
  started_at        timestamptz NOT NULL,
  finished_at       timestamptz NULL,
  tool_calls        int NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  cancel_requested  boolean NOT NULL DEFAULT false,
  error             text NULL
);
CREATE INDEX investigations_incident ON investigations (incident_id, started_at);

-- evidence-and-report.md §1; append-only
CREATE TABLE evidence (
  id                text NOT NULL CHECK (id ~ '^ev_[1-9][0-9]*$'),
  investigation_id  uuid NOT NULL REFERENCES investigations(id),
  tool              text NOT NULL,
  source            text NOT NULL CHECK (source IN ('prometheus','loki')),
  args              jsonb NULL,
  rendered_query    text NULL,
  window_start      timestamptz NULL,
  window_end        timestamptz NULL,
  status            text NOT NULL,
  error             text NULL CHECK (char_length(error) <= 300),
  result            jsonb NULL,
  stats             jsonb NOT NULL,
  duration_ms       int NOT NULL CHECK (duration_ms >= 0),
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (investigation_id, id),
  CHECK ((window_start IS NULL) = (window_end IS NULL))
);

CREATE TABLE reports (
  investigation_id  uuid PRIMARY KEY REFERENCES investigations(id),
  report            jsonb NOT NULL,
  validation        text NOT NULL CHECK (validation IN ('passed','failed')),
  violations        jsonb NOT NULL,
  warnings          jsonb NOT NULL,
  repair_attempted  boolean NOT NULL
);

-- §1a, exactly as written
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
  latency_ms        int NOT NULL CHECK (latency_ms >= 0),
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

CREATE TABLE scenario_runs (
  id               uuid PRIMARY KEY,
  scenario         text NOT NULL CHECK (scenario IN ('S1','S2')),
  incident_id      uuid NULL REFERENCES incidents(id),
  signal_summary   jsonb NULL,
  valid            boolean NULL,
  invalid_reasons  jsonb NULL,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NULL
);
