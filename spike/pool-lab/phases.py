"""SPIKE ONLY: min/max of each contract template per scenario phase. Usage: phases.py <times.env> [service]"""
import datetime, json, sys, urllib.parse, urllib.request

env = dict(l.strip().split('=', 1) for l in open(sys.argv[1]) if '=' in l)
svc = sys.argv[2] if len(sys.argv) > 2 else 'demo-service'
Q = {
    'latency_p95': 'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="$svc"}[1m])))',
    'err_5xx': 'sum(rate(http_server_request_duration_seconds_count{service_name="$svc",http_response_status_code=~"5.."}[1m])) / sum(rate(http_server_request_duration_seconds_count{service_name="$svc"}[1m]))',
    'used': 'sum(last_over_time(db_client_connection_count{service_name="$svc",db_client_connection_state="used"}[15s]))',
    'idle': 'sum(last_over_time(db_client_connection_count{service_name="$svc",db_client_connection_state="idle"}[15s]))',
    'pending': 'sum(last_over_time(db_client_connection_pending_requests{service_name="$svc"}[15s]))',
    'wait_p95': 'histogram_quantile(0.95, sum by (le) (rate(db_client_connection_wait_time_seconds_bucket{service_name="$svc"}[1m])))',
    'timeouts/s': 'sum(rate(db_client_connection_timeouts_total{service_name="$svc"}[1m]))',
    'query_p95': 'histogram_quantile(0.95, sum by (le) (rate(db_client_operation_duration_seconds_bucket{service_name="$svc"}[1m])))',
    'el_util': 'max(last_over_time(nodejs_eventloop_utilization_ratio{service_name="$svc"}[15s]))',
    'el_p99': 'max(last_over_time(nodejs_eventloop_delay_p99_seconds{service_name="$svc"}[15s]))',
}
ts = lambda s: int(datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())
phases = [('baseline', env['T0'], env['T_DEPLOY']), ('after deploy', env['T_DEPLOY'], env['T_DROP']), ('load 20%', env['T_DROP'], env['T_END'])]
print('| phase | ' + ' | '.join(Q) + ' |')
print('|---' * (len(Q) + 1) + '|')
for name, a, b in phases:
    cells = []
    for q in Q.values():
        u = 'http://localhost:9090/api/v1/query_range?' + urllib.parse.urlencode({'query': q.replace('$svc', svc), 'start': ts(a), 'end': ts(b), 'step': 15})
        r = json.load(urllib.request.urlopen(u))['data']['result']
        v = [float(x[1]) for x in (r[0]['values'] if r else []) if x[1] != 'NaN']
        cells.append(f'{min(v):.3g}–{max(v):.3g}' if v else '—')
    print(f'| {name} | ' + ' | '.join(cells) + ' |')
