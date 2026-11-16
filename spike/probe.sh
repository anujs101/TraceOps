#!/usr/bin/env bash
# Spike probe: query Prometheus and Loki HTTP APIs from the host and print
# what names/labels actually exist. Read-only.
set -u
PROM=${PROM:-http://localhost:9090}
LOKI=${LOKI:-http://localhost:3100}
NOW=$(date +%s); START=$((NOW - 900))

echo "### Prometheus: metric names matching our instruments"
curl -s "$PROM/api/v1/label/__name__/values" | python3 -c '
import sys, json
names = json.load(sys.stdin)["data"]
for n in names:
    if n.startswith(("db_client", "http_server", "target_info")) or "db.client" in n or "http.server" in n:
        print(" ", n)'

echo; echo "### Prometheus: labels on pool + http series"
for m in db_client_connection_count db_client_connection_pending_requests http_server_request_duration_seconds_count; do
  echo "-- $m"
  curl -s -G "$PROM/api/v1/series" --data-urlencode "match[]=$m" | python3 -c '
import sys, json
d = json.load(sys.stdin).get("data", [])
for s in d[:4]: print("  ", s)
if not d: print("   (no series)")'
done

echo; echo "### Prometheus: a real PromQL query (p95 latency by route)"
curl -s -G "$PROM/api/v1/query" --data-urlencode \
  'query=histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[1m])))' \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ", d.get("status"), [ (r["metric"], r["value"][1]) for r in d.get("data",{}).get("result",[]) ][:5])'

echo; echo "### Loki: reachable? labels"
curl -s -m 5 "$LOKI/ready"; echo
curl -s -m 5 "$LOKI/loki/api/v1/labels" ; echo

echo; echo "### Loki: label values for service_name"
curl -s -m 5 "$LOKI/loki/api/v1/label/service_name/values"; echo

echo; echo "### Loki: query_range for error logs (shows stream labels + structured metadata)"
curl -s -m 5 -G "$LOKI/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="spike-service"} |= "timeout exceeded"' \
  --data-urlencode "start=${START}000000000" --data-urlencode "end=${NOW}000000000" \
  --data-urlencode 'limit=2' --data-urlencode 'categorize_labels=true' \
  -H 'X-Loki-Response-Encoding-Flags: categorize-labels' | python3 -m json.tool | head -60
