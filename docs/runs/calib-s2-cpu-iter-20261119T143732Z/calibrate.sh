#!/bin/zsh
# CPU_ITER calibration for S2: demo-service FAULT=cpu_burn at 30 rps, 90 s per value, NO TraceOps app.
# Writes one line per value to calib-times.txt: "<iter> <t0> <t1>" (epoch s). Metrics are read afterwards.
set -u
S=/private/tmp/claude-501/-Users-anujs101-Developer-2027-TraceOps/3c5acb41-23bf-479c-99f4-970b4ac318e7/scratchpad
REPO=/Users/anujs101/Developer/2027/TraceOps
cd $REPO/apps/demo-service
if lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null; then echo "ABORT: TraceOps app on :4000 is running (would detect + spend tokens)"; exit 2; fi
if lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null; then echo "ABORT: :8080 busy"; exit 2; fi
: > $S/calib-times.txt
for X in 300000 400000 500000 650000 800000; do
  FAULT=cpu_burn CPU_ITER=$X SERVICE_VERSION=1.0.1 node --require ./dist/otel.js ./dist/main.js >> $S/calib-app.log 2>&1 &
  APP=$!
  for i in $(seq 1 120); do curl -sf localhost:8080/healthz >/dev/null && break; sleep 0.25; done
  t0=$(date +%s)
  RPS=30 SECONDS=90 npx tsx load/cli.ts >> $S/calib-load.log 2>&1
  t1=$(date +%s)
  kill -TERM $APP; wait $APP 2>/dev/null
  echo "$X $t0 $t1" | tee -a $S/calib-times.txt
  sleep 30   # gap: rate[1m] of the next value's measured part (t0+30..t1) sees no earlier samples
done
uptime
echo "calibration done"
