import { z } from 'zod';
import { IsoInput, IsoUtcMs } from './time.ts';
import { METRIC_NAMES, SEVERITIES, LOG_ALLOWED_FIELDS } from './telemetry.ts';

/**
 * Tool INPUT schemas. These are what the model fills (strict tool use).
 * They intentionally carry no string/number/array constraints, because the
 * providers' strict schema modes do not support them; the `*Checked` variants
 * add the server-side limits and are applied before execution.
 */
export const WindowInput = z.union([
  z.object({ start: z.string(), end: z.string() }).strict(),
  z.enum(['incident', 'baseline']),
]);

export const QueryMetricInput = z.object({ metric: z.enum(METRIC_NAMES), window: WindowInput }).strict();
export const SearchLogsInput = z.object({
  window: WindowInput,
  severity: z.enum(SEVERITIES).nullable(),
  match: z.object({ field: z.enum(['message', 'exception_message']), contains: z.string() }).strict().nullable(),
  limit: z.number().nullable(), // .int() would emit min/max bounds the API rejects; checked server-side
}).strict();
export const LogPatternsInput = z.object({ window: WindowInput, severity: z.enum(SEVERITIES).nullable() }).strict();
export const LogVolumeInput = z.object({ window: WindowInput }).strict();

export const TOOL_INPUTS = {
  query_metric: QueryMetricInput,
  search_logs: SearchLogsInput,
  log_patterns: LogPatternsInput,
  log_volume: LogVolumeInput,
} as const;
export type ToolName = keyof typeof TOOL_INPUTS;
export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as [ToolName, ...ToolName[]];

/** Server-side checks layered on top of the model-facing schema. */
const CheckedWindow = z.union([
  z.object({ start: IsoInput, end: IsoInput }).strict()
    .refine((w) => Date.parse(w.end) > Date.parse(w.start), 'end must be after start')
    .refine((w) => Date.parse(w.end) - Date.parse(w.start) <= 60 * 60_000, 'window must be <= 60 min'),
  z.enum(['incident', 'baseline']),
]);
export const SearchLogsChecked = SearchLogsInput.extend({
  window: CheckedWindow,
  match: z.object({ field: z.enum(['message', 'exception_message']), contains: z.string().min(1).max(100) }).strict().nullable(),
  limit: z.number().int().min(1).max(50).nullable(),
});
export const QueryMetricChecked = QueryMetricInput.extend({ window: CheckedWindow });
export const LogPatternsChecked = LogPatternsInput.extend({ window: CheckedWindow });
export const LogVolumeChecked = LogVolumeInput.extend({ window: CheckedWindow });

export const LIMITS = {
  maxToolCalls: 12,
  /** v1.5: calls of the 12 that query_metric cannot use (kept for log tools); query_metric gets at most maxToolCalls - logCallReserve. v1.6: a refused query_metric call does not count toward maxToolCalls. */
  logCallReserve: 4,
  maxWallClockMs: 180_000,
  backendTimeoutMs: 5_000,
  maxSeriesPoints: 60,
  searchLogsDefaultLimit: 20,
  patternSampleLines: 500,
  patternTopN: 15,
  logStringMaxChars: 300,
} as const;

/** Tool OUTPUTS (what the model sees inside <tool_data>). */
export const ToolStatus = z.enum(['ok', 'empty', 'error', 'budget_exhausted']);
const Window = z.object({ start: IsoUtcMs, end: IsoUtcMs }).strict();
const SeriesPoint = z.tuple([IsoUtcMs, z.number()]);
const SeriesStats = z.object({
  min: z.number(), max: z.number(), avg: z.number(), first: z.number(), last: z.number(), points: z.number().int(),
}).strict();

export const LogLine = z.object({
  timestamp: IsoUtcMs,
  message: z.string(),
  severity_text: z.string(),
  exception_type: z.string().nullable(),
  exception_message: z.string().nullable(),
  route: z.string().nullable(),
  status: z.number().int().nullable(), // parsed from Loki's string metadata
  duration_ms: z.number().nullable(), // parsed from Loki's string metadata
  service_version: z.string().nullable(),
}).strict();
// LogLine keys must equal the allowlist (checked in tests).
export const LOG_LINE_KEYS = Object.keys(LogLine.shape) as (typeof LOG_ALLOWED_FIELDS[number])[];

export const QueryMetricOutput = z.object({
  evidence_id: z.string(), status: ToolStatus, metric: z.enum(METRIC_NAMES), unit: z.string(),
  window: Window, step_s: z.number().int().positive(),
  stats: SeriesStats.nullable(), max_at: IsoUtcMs.nullable(), series: z.array(SeriesPoint).max(60),
  error: z.string().nullable(),
}).strict();

export const SearchLogsOutput = z.object({
  evidence_id: z.string(), status: ToolStatus, window: Window,
  lines: z.array(LogLine).max(50), truncated: z.boolean(), error: z.string().nullable(),
}).strict();

export const LogPatternsOutput = z.object({
  evidence_id: z.string(), status: ToolStatus, window: Window, sampled_lines: z.number().int(),
  patterns: z.array(z.object({
    rank: z.number().int().min(1),
    severity_text: z.string(), message: z.string(), exception_message: z.string().nullable(),
    count: z.number().int(), first_at: IsoUtcMs, last_at: IsoUtcMs, service_versions: z.array(z.string()),
  }).strict()).max(15),
  error: z.string().nullable(),
}).strict();

export const LogVolumeOutput = z.object({
  evidence_id: z.string(), status: ToolStatus, window: Window, step_s: z.number().int().positive(),
  by_severity: z.record(z.string(), z.object({ stats: SeriesStats.extend({ sum: z.number() }), series: z.array(SeriesPoint).max(60) }).strict()),
  error: z.string().nullable(),
}).strict();

export const TOOL_OUTPUTS = {
  query_metric: QueryMetricOutput,
  search_logs: SearchLogsOutput,
  log_patterns: LogPatternsOutput,
  log_volume: LogVolumeOutput,
} as const;
