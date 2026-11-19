---
description: Run scenario S1 live end to end through the integrated TraceOps app and report validity and the investigation result
---
Run S1 (connection leak) on the live stack through the integrated app: detector → worker → investigator → API. **This spends LLM tokens. Run it only when the user asked for a live run in this conversation.**

Never read, cat or print `.env`. The app process gets its env only through `--env-file` (`npm run start:env`). Don't echo env values, and don't print the app log unfiltered (check it for key-like strings first, as step 7 does).

## Steps
1. **Stack.** `docker compose -f infra/compose.yml up -d`. Wait for `curl -s localhost:9090/-/ready` and `curl -s localhost:3100/ready`. Check that nothing else listens on 4000 or 8080 (`lsof -nP -iTCP:4000 -iTCP:8080 -sTCP:LISTEN`). Follow the `scenario-runner` skill's preconditions: no `spike-*` containers, and ≥ 5 min cool-down since the last demo-service run.
2. **TraceOps app** (background, log in the scratchpad):
   `LLM_PROVIDER=deepseek npm run start:env -w @traceops/app > <scratchpad>/traceops.log 2>&1`
   - Shell env wins over `--env-file`, so `LLM_PROVIDER=deepseek` takes effect even if `.env` sets groq. It uses compose Postgres :5432 (`traceops` DB), not c-pg.
   - Wait for `curl -s localhost:4000/api/health` to return `{"status":"ok"}`. If startup fails (for example a missing `DEEPSEEK_API_KEY`), report the error line, never the env.
   - Record `RUN_START` (UTC ISO) now.
3. **Scenario** (background; about 10 min; it does baseline, fault deploy, load until alert + 3 min, then the drop):
   `npm run scenario -w apps/demo-service -- S1` (this builds demo-service first)
   Wait for it to exit. It writes `apps/demo-service/runs/S1-summary.json`. That path is session A's tracked acceptance evidence (docs/known-gaps.md), so **copy it to the scratchpad now**, then restore A's file with `git checkout apps/demo-service/runs/S1-summary.json`.
4. **Investigation result:** `npx tsx apps/traceops/scripts/s1-report.ts <RUN_START> 600`. It reads only the API and waits up to 10 min for a finished investigation.
5. **Let the incident resolve normally** (Contracts v1.3: a healthy service evaluates both rules to ok). The app keeps running. Never edit the database.
   - Start a healthy instance in the background: `FAULT=none SERVICE_VERSION=1.0.0 npm start -w apps/demo-service > <scratchpad>/demo-recover.log 2>&1`. Wait for `curl -s localhost:8080/healthz`.
   - Start light load in the background: `RPS=6 SECONDS=420 npm run load -w apps/demo-service > <scratchpad>/load-recover.log 2>&1`.
   - Wait: `npx tsx apps/traceops/scripts/wait-resolve.ts <RUN_START> 300`. Exit 0 means the incident resolved. **Exit 3** means it is still open after 5 min: the script prints a `!!! … STILL OPEN …` line. Report that line and the detector's missing-data and rule-transition lines for the group, and do **not** edit the database. The next run must not start until it is understood.
   - Stop the load and demo-service: `pkill -INT -f "load/cli.ts"; pkill -INT -f "dist/main.js"`. Demo-service is then down, so nothing faulty or healthy keeps writing samples. The next run's cool-down starts now.
6. **Stop the app:** `pkill -INT -f "src/app/main.ts"`.
7. **Log hygiene:** `grep -cE "gsk_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9]{16,}|org_[A-Za-z0-9]{6,}" <log>` must be 0 before quoting any app log line.

## Report
1. Stack status (containers up, API healthy, demo-service healthy during the run).
2. The scenario's `SignalSummary` and `scenarioValid('S1', …)` result. An invalid run is reported with its reasons and **not graded**.
3. From `s1-report.ts`:
   - the incident: id, `started_at`, `detected_at`, trigger
   - the investigation: status, model, tool calls
   - the report: `status`, top hypothesis category, `validation`, violations
   - `llm_calls` totals: attempts, errors by kind, tokens, latency
   - evidence rows
4. Time from `detected_at` to the report, measured as the investigation's `finished_at`, because the reports table has no `created_at`.
5. Whether the incident resolved normally, with `resolved_at` and the wait time, or the STILL OPEN line.
6. Anything unexpected in the app log, such as detector missing data, worker requeues, `worker_lost` or provider errors, quoted only after the log hygiene check.
