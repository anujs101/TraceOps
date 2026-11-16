#!/usr/bin/env bash
# SPIKE ONLY: S1 (pool leak) end-to-end run.
#  t=0     demo-service v1.0.0 FAULT=none, load 30 rps
#  t=120   restart as v1.0.1 FAULT=pool_leak (simulated deploy); load continues
#  t=140   staleness probe (old instance's gauges still visible?)
#  t=300   load drops to 6 rps for 90 s (does the pool recover?)
# Writes timestamps to ../runs/s1-times.env for fixture capture.
set -u
cd "$(dirname "$0")"
OUT=../runs; SVC=demo-service; P=http://localhost:9090
start_app() { FAULT=$1 SERVICE_VERSION=$2 SERVICE_NAME=$SVC node --require ./otel.cjs app.cjs >> $OUT/s1-app.log 2>&1 & echo $!; }
iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }

T0=$(iso); APP=$(start_app none 1.0.0); sleep 3
RPS=30 LOW_STOCK_SHARE=0.02 SECONDS=300 node load.cjs > $OUT/s1-load.log 2>&1 &
LOAD=$!
sleep 117
kill -TERM $APP; sleep 1; T_DEPLOY=$(iso); APP=$(start_app pool_leak 1.0.1)
sleep 20
echo "### staleness probe at deploy+20s ($(iso))" > $OUT/s1-staleness.txt
for Q in \
  "count(db_client_connection_count{service_name=\"$SVC\",db_client_connection_state=\"idle\"})" \
  "count(last_over_time(db_client_connection_count{service_name=\"$SVC\",db_client_connection_state=\"idle\"}[15s]))" \
  "sum(db_client_connection_count{service_name=\"$SVC\",db_client_connection_state=\"idle\"})" \
  "sum(last_over_time(db_client_connection_count{service_name=\"$SVC\",db_client_connection_state=\"idle\"}[15s]))" \
  "count by (instance) (db_client_connection_count{service_name=\"$SVC\"})"; do
  printf '%s\n  => %s\n' "$Q" "$(curl -s -G $P/api/v1/query --data-urlencode "query=$Q" | python3 -c 'import sys,json; print([(r["metric"], r["value"][1]) for r in json.load(sys.stdin)["data"]["result"]])')" >> $OUT/s1-staleness.txt
done
wait $LOAD
T_DROP=$(iso)
RPS=6 LOW_STOCK_SHARE=0.02 SECONDS=90 node load.cjs > $OUT/s1-load-low.log 2>&1
sleep 15; T_END=$(iso)
kill -TERM $APP
printf 'T0=%s\nT_DEPLOY=%s\nT_DROP=%s\nT_END=%s\n' "$T0" "$T_DEPLOY" "$T_DROP" "$T_END" > $OUT/s1-times.env
echo done
