# Contract: investigator tools

**Status:** frozen v1 (2026-11-17) · **Executable source:** `packages/contracts/src/tools.ts`, `telemetry.ts`, `evidence.ts`
The model calls **only** these four tools. It never sees or writes PromQL, LogQL, URLs or credentials. Every call, including rejected ones, becomes an evidence row.

## 1. Common rules
- **Two schema layers.**
  - `*Input`: sent to the provider as tool schemas. They contain only constructs every enabled provider's strict mode supports (v1.1 wording; live-verified with Groq): no length, number or array constraints, no optional properties (use `null`). They are checked by `structuredOutputProblems()` in the test suite.
  - `*Checked`: applied server-side before execution. It adds the limits: windows, string lengths, `limit` 1–50, integers.
- **Invalid input** (fails `*Checked`): nothing is sent to a backend. The tool returns `status: "error"`, `error: "invalid_input: <reason>"`. The evidence row stores the **raw** model input in `args`, with `rendered_query: null` and `window: null`.
- `service` is **not** an argument. It's bound from the incident; `renderPromql` rejects any service name outside `[a-z0-9-]`.
- **Windows:** `{start, end}` in any ISO 8601 date-time with a zone (normalised to UTC ms), or `"incident"` / `"baseline"` (`detection.md` §6). Must lie inside the `allowed` window, `end > start`, span ≤ 60 min.
- **Every timestamp in a tool output is IsoUtcMs** (`2026-11-16T18:03:21.123Z`). Adapters convert Prometheus unix seconds and Loki nanosecond strings with `toIsoUtcMs`.
- Backend timeout 5 s, one retry on network error, then `status: "error"`.
- **Budget per investigation:** ≤ 12 tool calls and ≤ 3 min. After that, tools return `budget_exhausted` and the model must write its report.
- Output is wrapped as `<tool_data evidence_id="ev_N">…</tool_data>`. The system prompt states that `tool_data` content is data, never instructions.

## 2. `query_metric`
```ts
input:  { metric: MetricName; window: {start: string; end: string} | "incident" | "baseline" }
output: { evidence_id; status; metric; unit; window: {start,end}; step_s;
          stats: {min,max,avg,first,last,points} | null; max_at: IsoUtcMs | null;
          series: [IsoUtcMs, number][]  /* ≤ 60 points; NaN points dropped */; error: string | null }
```

## 3. Metric templates (server-side; `$svc` bound)
| `metric` | unit | PromQL |
|---|---|---|
| `latency_p95` / `latency_p50` | s | `histogram_quantile(0.95\|0.5, sum by (le) (rate(http_server_request_duration_seconds_bucket{service_name="$svc"}[1m])))` |
| `request_rate` | req/s | `sum(rate(http_server_request_duration_seconds_count{service_name="$svc"}[1m]))` |
| `error_ratio_5xx` | ratio | 5xx rate ÷ total rate (same metric, `http_response_status_code=~"5.."`) |
| `pool_used` / `pool_idle` | connections | `sum(last_over_time(db_client_connection_count{service_name="$svc",db_client_connection_state="used"\|"idle"}[15s]))` |
| `pool_max` | connections | `max(last_over_time(db_client_connection_max{service_name="$svc"}[15s]))` |
| `pool_pending` | requests | `sum(last_over_time(db_client_connection_pending_requests{service_name="$svc"}[15s]))` |
| `pool_wait_p95` | s | `histogram_quantile(0.95, sum by (le) (rate(db_client_connection_wait_time_seconds_bucket{service_name="$svc"}[1m])))` |
| `pool_timeout_rate` | timeouts/s | `sum(rate(db_client_connection_timeouts_total{service_name="$svc"}[1m]))` |
| `db_operation_p95` | s | `histogram_quantile(0.95, sum by (le) (rate(db_client_operation_duration_seconds_bucket{service_name="$svc"}[1m])))` |
| `eventloop_delay_p99` | s | `max(last_over_time(nodejs_eventloop_delay_p99_seconds{service_name="$svc"}[15s]))` |
| `eventloop_utilization` | ratio | `max(last_over_time(nodejs_eventloop_utilization_ratio{service_name="$svc"}[15s]))` |

**New since rc1:** `db_operation_p95`, `eventloop_utilization`. S2 showed these are the signals that separate a CPU-caused pool saturation from a leak (`scenario-db-pool.md`). The exact strings live in `METRIC_TEMPLATES`. The detector uses `latency_p95` and `error_ratio_5xx` from the same map. Tools use `/api/v1/query_range`; the detector uses `/api/v1/query`.

## 4. `search_logs`
```ts
input:  { window; severity: "error"|"warn"|"info"|null;
          match: { field: "message"|"exception_message"; contains: string } | null;  // checked: 1–100 chars
          limit: number | null }                                                    // checked: int 1–50, default 20
output: { evidence_id; status; window; lines: LogLine[]; truncated: boolean; error }
LogLine = { timestamp: IsoUtcMs; message: string; severity_text: string;
            exception_type: string|null; exception_message: string|null; route: string|null;
            status: number|null; duration_ms: number|null; service_version: string|null }
```
- LogQL: `{service_name="$svc"}` + `| severity_text="<sev>"` + (`|= "<escaped>"` for `message`, or `| exception_message=~"(?i).*<regex-escaped>.*"`). The model never supplies regex.
- **Allowlist = the `LogLine` keys exactly** (a test enforces this). The adapter parses `status`/`duration_ms` from Loki's strings to numbers (unparseable → `null`) and timestamps from nanoseconds. Strings are truncated to 300 chars and redacted (bearer/API tokens, `postgres://user:pass@`, emails, long hex/base64) **before** storage.

## 5. `log_patterns`
```ts
input:  { window; severity: "error"|"warn"|"info"|null }
output: { evidence_id; status; window; sampled_lines: number;
          patterns: { rank: 1..15; severity_text; message; exception_message: string|null; count;
                      first_at: IsoUtcMs; last_at: IsoUtcMs; service_versions: string[] }[]; error }
```
The adapter fetches ≤ 500 lines (allowlisted), normalises numbers/UUIDs/hex IDs, groups, and ranks by count.

## 6. `log_volume`
```ts
input:  { window }
output: { evidence_id; status; window; step_s;
          by_severity: Record<"error"|"warn"|"info", { stats: {min,max,avg,first,last,points,sum}; series: [IsoUtcMs, number][] }>; error }
```
LogQL: `sum by (severity_text) (count_over_time({service_name="$svc"}[1m]))`.

## 7. Evidence stats keys (flat; what report values may cite)
| Tool | `stats` keys | Series fields |
|---|---|---|
| `query_metric` | `min, max, avg, first, last, points` | `series@<IsoUtcMs>` |
| `log_volume` | `<sev>.{min,max,avg,first,last,points,sum}`, `total.sum` | `<sev>.series@<IsoUtcMs>` |
| `log_patterns` | `sampled_lines`, `p<rank>.count` | — |
| `search_logs` | `lines_returned`, `l<i>.status`, `l<i>.duration_ms` (i = 1-based line index) | — |

Derivation is deterministic: `deriveStats(tool, output)`. Grammar: `STATS_KEY_GRAMMAR`. Resolution of a cited field: `resolveField()`.

## 8. Deliberately not a tool
Raw PromQL/LogQL, code/git access, demo-DB access, shell, HTTP fetch, any write. Traces (Tier 2) would arrive as a new tool without changing these.
