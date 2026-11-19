# Handoff: session/A-demo (demo-service + infra)

## Done and verified
- /verify (this turn): typecheck passes in contracts, demo-service, @traceops/app. Tests: contracts 110/110, demo-service 12/12, @traceops/app 96/96 (baselines held).
- /contract-check: CONTRACTS UNCHANGED vs main.
- Live S1 run (`apps/demo-service/runs/S1-run.out`, `S1-summary.json`): `scenarioValid('S1')` = `{"valid":true,"reasons":[]}`. Pool used 10/10 for 205 s, ~6562 acquire timeouts, event-loop utilisation max 0.11, `used` still 10 after the load drop, baseline clean.
- Prometheus (queried after the run): all nine telemetry.md §3 metrics return data for `service_name="demo-service"`. The faulty instance has one series per `db_client_connection_state`, with pool name `main` only.
- Loki: `request failed` lines carry `exception_message="timeout exceeded when trying to connect"`. Zero forbidden-phrase matches in Loki and in the app log.
- Unit tests cover fault flag parsing, the 409 release path (only `pool_leak` skips release), error handler (500 + `request failed` with `err`), forbidden phrases.

## Done, not verified
- S2 (`cpu_burn`) is implemented (`pbkdf2Sync` in `GET /products`) but was never run live. Out of the acceptance list; no S2 validity result exists.
- `exception_stacktrace`, `host_*`, `process_*` and `process_owner` are present in Loki as telemetry.md §4 says. They contain the OS username and absolute paths, so the tools allowlist must keep dropping them.

## Not done
- Nothing from the spec's Build list (steps 1-5) is outstanding.

## Deviations and proposals
- No proposals written by this branch. `docs/proposals/contracts-v1.1.md` predates it.
- Cool-down: the runner waits until Prometheus holds no demo-service samples from the last 300 s. The 60 s load drop and the 90 s baseline are the contract floors.
- The only added number is `ALERT_WAIT_CAP_S = 600`, a script safety cap, not a load-profile value.

## How to run it
```bash
docker compose -f infra/compose.yml up -d            # ~2 min cold; leave running
npm run build -w apps/demo-service
npm run scenario -w apps/demo-service -- S1          # or S2; ~10 min; writes apps/demo-service/runs/
npm start -w apps/demo-service                       # service alone (set FAULT, SERVICE_VERSION, CPU_ITER)
RPS=30 SECONDS=60 npm run load -w apps/demo-service  # load alone
```

## For the integrator
- Branch has 6 commits (infra, app, tests, load, runner, run evidence). Root `package-lock.json` is modified in the worktree and was never committed; regenerate with `npm install` at merge.
- New workspace `@traceops/demo-service` (CommonJS). Its `src/` never imports contracts; tests and scripts do.
- On this arm64 Mac vitest needed `npm install --no-save @rolldown/binding-darwin-arm64@1.2.19` (npm optional-deps bug); no manifest change.
- A run reuses `service_name`, so wait ≥5 min between runs. The compose stack was left running.
- Postgres is pinned to `postgres:18.6`, users/databases `demo` and `traceops` (password = username).
