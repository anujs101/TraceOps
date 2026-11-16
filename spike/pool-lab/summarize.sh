#!/usr/bin/env bash
# SPIKE ONLY: max/min of each contract template over [now-RANGE, now] for lab-service.
RANGE=${RANGE:-90s}; SVC=${SVC:-lab-service}; P=http://localhost:9090
q() { curl -s -G $P/api/v1/query --data-urlencode "query=$2" | python3 -c "import sys,json; r=json.load(sys.stdin)['data']['result']; print('  %-22s %s' % ('$1', r[0]['value'][1] if r else '(empty)'))"; }
echo "window: last $RANGE"
q latency_p95_max      "max_over_time((histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name=\"$SVC\"}[1m]))))[$RANGE:5s])"
q error_ratio_5xx_max  "max_over_time((sum(rate(http_server_request_duration_seconds_count{service_name=\"$SVC\",http_response_status_code=~\"5..\"}[1m])) / sum(rate(http_server_request_duration_seconds_count{service_name=\"$SVC\"}[1m])))[$RANGE:5s])"
q pool_used_max        "max_over_time((sum(last_over_time(db_client_connection_count{service_name=\"$SVC\",db_client_connection_state=\"used\"}[15s])))[$RANGE:5s])"
q pool_idle_min        "min_over_time((sum(last_over_time(db_client_connection_count{service_name=\"$SVC\",db_client_connection_state=\"idle\"}[15s])))[$RANGE:5s])"
q pool_pending_max     "max_over_time((sum(last_over_time(db_client_connection_pending_requests{service_name=\"$SVC\"}[15s])))[$RANGE:5s])"
q pool_wait_p95_max    "max_over_time((histogram_quantile(0.95, sum by (le) (rate(db_client_connection_wait_time_seconds_bucket{service_name=\"$SVC\"}[1m]))))[$RANGE:5s])"
q pool_timeouts_incr   "sum(increase(db_client_connection_timeouts_total{service_name=\"$SVC\"}[$RANGE]))"
q eventloop_p99_max    "max_over_time((max(last_over_time(nodejs_eventloop_delay_p99_seconds{service_name=\"$SVC\"}[15s])))[$RANGE:5s])"
q eventloop_util_max   "max_over_time((max(last_over_time(nodejs_eventloop_utilization_ratio{service_name=\"$SVC\"}[15s])))[$RANGE:5s])"
q db_op_p95_max        "max_over_time((histogram_quantile(0.95, sum by (le) (rate(db_client_operation_duration_seconds_bucket{service_name=\"$SVC\"}[1m]))))[$RANGE:5s])"
