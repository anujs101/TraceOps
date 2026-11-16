#!/usr/bin/env bash
# Capture RAW Prometheus/Loki API responses for the contract templates from a
# real lab run. Output: packages/contracts/fixtures/<scenario>/*.json + manifest.json
# Usage: capture-fixtures.sh <scenario> <service_name> <start_iso> <end_iso>
set -euo pipefail
SC=$1; SVC=$2; START=$3; END=$4
ROOT=$(cd "$(dirname "$0")/../.." && pwd); OUT=$ROOT/packages/contracts/fixtures/$SC; mkdir -p "$OUT"
P=http://localhost:9090; L=http://localhost:3100
toS() { python3 -c "import sys,datetime; print(int(datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')).timestamp()))" "$1"; }
S=$(toS "$START"); E=$(toS "$END")
TEMPLATES=$(cd "$ROOT/packages/contracts" && node --experimental-strip-types -e "
import('./src/telemetry.ts').then(m => { for (const k of m.METRIC_NAMES) console.log(k + '\t' + m.renderPromql(k, '$SVC')); })" 2>/dev/null)
echo "$TEMPLATES" | while IFS=$'\t' read -r NAME Q; do
  curl -s -G "$P/api/v1/query_range" --data-urlencode "query=$Q" --data-urlencode "start=$S" --data-urlencode "end=$E" --data-urlencode "step=15" > "$OUT/prom-$NAME.json"
done
lq() { curl -s -G "$L/loki/api/v1/query_range" -H 'X-Loki-Response-Encoding-Flags: categorize-labels' \
  --data-urlencode "query=$2" --data-urlencode "start=${S}000000000" --data-urlencode "end=${E}000000000" "${@:3}" > "$OUT/$1.json"; }
lq loki-search-errors-exception "{service_name=\"$SVC\"} | severity_text=\"error\" | exception_message=~\"(?i).*timeout.*\"" --data-urlencode limit=20
lq loki-search-warn "{service_name=\"$SVC\"} | severity_text=\"warn\"" --data-urlencode limit=20
lq loki-patterns-sample "{service_name=\"$SVC\"} | severity_text=~\"error|warn\"" --data-urlencode limit=100
lq loki-volume "sum by (severity_text) (count_over_time({service_name=\"$SVC\"}[1m]))" --data-urlencode step=60
# error + empty shapes, for adapter error handling
curl -s -G "$P/api/v1/query_range" --data-urlencode 'query=sum(rate(' --data-urlencode "start=$S" --data-urlencode "end=$E" --data-urlencode step=15 > "$OUT/prom-error-badquery.json"
curl -s -G "$P/api/v1/query_range" --data-urlencode 'query=sum(rate(http_server_request_duration_seconds_count{service_name="no-such-service"}[1m]))' --data-urlencode "start=$S" --data-urlencode "end=$E" --data-urlencode step=15 > "$OUT/prom-empty.json"
# Scrub host/user identifying values from labels and structured metadata (fixtures are committed).
python3 - "$OUT" <<'EOF'
import json, os, sys
SCRUB = {'host_name','host_id','host_arch','os_version','process_owner','process_command','process_command_args',
         'process_command_line','process_executable_path','process_executable_name','process_pid','service_instance_id','instance',
         'exception_stacktrace'}
def walk(x):
    if isinstance(x, dict):
        return {k: ('<scrubbed>' if k in SCRUB and isinstance(v, str) else walk(v)) for k, v in x.items()}
    if isinstance(x, list): return [walk(v) for v in x]
    return x
for f in os.listdir(sys.argv[1]):
    if f.endswith('.json'):
        p = os.path.join(sys.argv[1], f); d = json.load(open(p)); json.dump(walk(d), open(p, 'w'), indent=1)
EOF
python3 -c 'import json,sys; print(json.dumps({"scenario":sys.argv[1],"service":sys.argv[2],"start":sys.argv[3],"end":sys.argv[4],"deploy_at":sys.argv[5],"backend":"grafana/otel-lgtm:0.40.0","step_s":15,"captured_by":"spike/pool-lab/capture-fixtures.sh","notes":sys.argv[6]}, indent=1))' \
  "$SC" "$SVC" "$START" "$END" "${DEPLOY_AT:-}" "${NOTES:-}" > "$OUT/manifest.json"
ls -la "$OUT" | awk '{print $5, $9}'
