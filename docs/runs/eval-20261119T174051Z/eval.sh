#!/bin/zsh
# Round-2 eval: S1 x3 then S2 x3, sequential, unattended (run under `caffeinate -i`).
# Per run (the /s1-run procedure): app up -> RUN_START -> scenario (runner does cool-down, 7 min baseline,
# fault, alert + 3 min, drop) -> wait for the investigation -> collect into docs/runs/<s>-<UTC>/ ->
# restore A's tracked S1-summary.json -> recover (FAULT=none + 6 rps, wait-resolve) -> stop -> log hygiene.
# Stops the whole eval on: app start failure, STILL OPEN incident, key-scan hit. Invalid runs are recorded and the eval continues.
# Reads no .env; the app gets its env only via --env-file (npm run start:env).
set -u
S=/private/tmp/claude-501/-Users-anujs101-Developer-2027-TraceOps/3c5acb41-23bf-479c-99f4-970b4ac318e7/scratchpad
REPO=/Users/anujs101/Developer/2027/TraceOps
E=$S/eval
mkdir -p $E
cd $REPO
echo "eval start $(date -u +%FT%TZ) on $(git rev-parse --short HEAD)" | tee $E/eval.log
KEYS='gsk_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9]{16,}|org_[A-Za-z0-9]{6,}'

stop_all() {
  pkill -INT -f "load/cli.ts" 2>/dev/null; pkill -INT -f "dist/main.js" 2>/dev/null
  pkill -INT -f "src/app/main.ts" 2>/dev/null
  for i in $(seq 1 40); do lsof -nP -iTCP:4000 -iTCP:8080 -sTCP:LISTEN >/dev/null || break; sleep 0.5; done
}

n=0
for SC in S1 S1 S1 S2 S2 S2; do
  n=$((n+1)); TAG=$n-$SC
  if lsof -nP -iTCP:4000 -iTCP:8080 -sTCP:LISTEN >/dev/null; then echo "ABORT $TAG: :4000 or :8080 busy" | tee -a $E/eval.log; exit 2; fi
  LLM_PROVIDER=deepseek npm run start:env -w @traceops/app > $E/app-$TAG.log 2>&1 &
  ok=0; for i in $(seq 1 120); do curl -sf localhost:4000/api/health | grep -q '"ok"' && { ok=1; break; }; sleep 0.5; done
  if [ $ok != 1 ]; then echo "ABORT $TAG: app did not become healthy" | tee -a $E/eval.log; echo "key-like hits in app log: $(grep -cE "$KEYS" $E/app-$TAG.log)" | tee -a $E/eval.log; stop_all; exit 2; fi
  RUN_START=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  OUT=$REPO/docs/runs/$(echo $SC | tr A-Z a-z)-$STAMP
  echo "[$TAG] run_start $RUN_START load: $(uptime | sed 's/.*load/load/')" | tee -a $E/eval.log
  npm run scenario -w apps/demo-service -- $SC > $E/scenario-$TAG.out 2>&1
  echo "[$TAG] scenario exit $? $(grep "scenarioValid" $E/scenario-$TAG.out)" | tee -a $E/eval.log
  cp apps/demo-service/runs/$SC-summary.json $E/$SC-summary-$TAG.json
  git checkout -q apps/demo-service/runs/S1-summary.json 2>/dev/null
  rm -f apps/demo-service/runs/S2-summary.json
  fired=$(node -e "console.log(require('$E/$SC-summary-$TAG.json').summary.latency_alert_fired)")
  if [ "$fired" = "true" ]; then
    npx tsx apps/traceops/scripts/s1-report.ts $RUN_START 600 > $E/report-$TAG.out 2>&1
    echo "[$TAG] s1-report exit $?" | tee -a $E/eval.log
  fi
  npx tsx $S/collect-run-eval.mts $SC $RUN_START $E/$SC-summary-$TAG.json $OUT > $E/collect-$TAG.out 2>&1
  rc=$?; echo "[$TAG] collect exit $rc -> $OUT" | tee -a $E/eval.log
  if [ $rc = 2 ]; then echo "ABORT $TAG: key scan hit" | tee -a $E/eval.log; stop_all; exit 2; fi
  # recover: healthy instance + light load until the incident resolves normally (no DB edits)
  (cd apps/demo-service && FAULT=none SERVICE_VERSION=1.0.0 npm start > $E/recover-demo-$TAG.log 2>&1 &)
  for i in $(seq 1 120); do curl -sf localhost:8080/healthz >/dev/null && break; sleep 0.25; done
  (env RPS=6 SECONDS=420 npm run load -w apps/demo-service > $E/recover-load-$TAG.log 2>&1 &)
  npx tsx apps/traceops/scripts/wait-resolve.ts $RUN_START 300 > $E/resolve-$TAG.out 2>&1
  wr=$?; echo "[$TAG] wait-resolve exit $wr $(tail -1 $E/resolve-$TAG.out)" | tee -a $E/eval.log
  stop_all
  hits=$(grep -cE "$KEYS" $E/app-$TAG.log); echo "[$TAG] log hygiene hits: $hits" | tee -a $E/eval.log
  if [ $wr = 3 ]; then echo "ABORT $TAG: incident STILL OPEN; not continuing" | tee -a $E/eval.log; exit 3; fi
done
echo "eval done $(date -u +%FT%TZ) load: $(uptime | sed 's/.*load/load/')" | tee -a $E/eval.log
