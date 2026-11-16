#!/usr/bin/env bash
# SPIKE ONLY: S2 (CPU burn) end-to-end run, same telemetry setup as S1.
#  t=0    demo-service v1.0.0 FAULT=none, load 30 rps
#  t=90   restart as v1.0.1 FAULT=cpu_burn CPU_ITER=$CPU_ITER; load continues
#  t=210  load drops to 6 rps for 60 s (does the pool recover? it should)
set -u
cd "$(dirname "$0")"
OUT=../runs/s2; mkdir -p $OUT; SVC=demo-service; CPU_ITER=${CPU_ITER:-300000}
start_app() { FAULT=$1 SERVICE_VERSION=$2 SERVICE_NAME=$SVC CPU_ITER=$CPU_ITER node --require ./otel.cjs app.cjs >> $OUT/app.log 2>&1 & echo $!; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
T0=$(iso); APP=$(start_app none 1.0.0); sleep 3
RPS=30 LOW_STOCK_SHARE=0.02 SECONDS=207 node load.cjs > $OUT/load.log 2>&1 &
LOAD=$!
sleep 87
kill -TERM $APP; sleep 1; T_DEPLOY=$(iso); APP=$(start_app cpu_burn 1.0.1)
wait $LOAD
T_DROP=$(iso)
RPS=6 LOW_STOCK_SHARE=0.02 SECONDS=60 node load.cjs > $OUT/load-low.log 2>&1
sleep 15; T_END=$(iso)
kill -TERM $APP
printf 'T0=%s\nT_DEPLOY=%s\nT_DROP=%s\nT_END=%s\nCPU_ITER=%s\n' "$T0" "$T_DEPLOY" "$T_DROP" "$T_END" "$CPU_ITER" > $OUT/times.env
echo done
