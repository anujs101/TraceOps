import { z } from 'zod';
import { IsoUtcMs } from './time.ts';
import { TOOL_NAMES, ToolStatus, type ToolName } from './tools.ts';

/**
 * Evidence: one row per tool call (also the audit log). `stats` is a FLAT map of
 * numbers whose keys follow STATS_KEY_GRAMMAR for the tool. Report values cite
 * either a stats key or a series point (`series@<IsoUtcMs>`, `<sev>.series@<IsoUtcMs>`).
 */
export const Evidence = z.object({
  id: z.string().regex(/^ev_[1-9]\d*$/),
  investigation_id: z.uuid(),
  tool: z.enum(TOOL_NAMES),
  source: z.enum(['prometheus', 'loki']),
  args: z.unknown(), // checked args (windows resolved) when valid; the raw model input when status=error/invalid_input
  rendered_query: z.string().nullable(), // null when input was invalid (nothing was sent)
  window: z.object({ start: IsoUtcMs, end: IsoUtcMs }).strict().nullable(),
  status: ToolStatus,
  error: z.string().max(300).nullable(), // e.g. "invalid_input: limit must be <= 50"
  result: z.unknown(), // exactly what the model saw (allowlisted + redacted)
  stats: z.record(z.string(), z.number()),
  duration_ms: z.number().int().nonnegative(),
  created_at: IsoUtcMs,
}).strict();
export type Evidence = z.infer<typeof Evidence>;

const SEV = '(error|warn|info)';
const STAT = '(min|max|avg|first|last|points)';
export const STATS_KEY_GRAMMAR: Record<ToolName, RegExp> = {
  query_metric: new RegExp(`^${STAT}$`),
  log_volume: new RegExp(`^(${SEV}\\.(${STAT.slice(1, -1)}|sum)|total\\.sum)$`),
  log_patterns: /^(sampled_lines|p([1-9]|1[0-5])\.count)$/,
  search_logs: /^(lines_returned|l([1-9]|[1-4]\d|50)\.(status|duration_ms))$/,
};
export const TOOL_SOURCE: Record<ToolName, 'prometheus' | 'loki'> = {
  query_metric: 'prometheus', search_logs: 'loki', log_patterns: 'loki', log_volume: 'loki',
};

/** Deterministic stats derivation from a tool output (executable spec for every adapter). */
export function deriveStats(tool: ToolName, out: any): Record<string, number> {
  const s: Record<string, number> = {};
  if (out?.status !== 'ok') return s;
  switch (tool) {
    case 'query_metric':
      if (out.stats) for (const k of ['min', 'max', 'avg', 'first', 'last', 'points']) s[k] = out.stats[k];
      break;
    case 'log_volume': {
      let total = 0;
      for (const [sev, v] of Object.entries<any>(out.by_severity ?? {})) {
        for (const k of ['min', 'max', 'avg', 'first', 'last', 'points', 'sum']) s[`${sev}.${k}`] = v.stats[k];
        total += v.stats.sum;
      }
      s['total.sum'] = total;
      break;
    }
    case 'log_patterns':
      s.sampled_lines = out.sampled_lines;
      for (const p of out.patterns ?? []) s[`p${p.rank}.count`] = p.count;
      break;
    case 'search_logs':
      s.lines_returned = out.lines.length;
      out.lines.forEach((l: any, i: number) => {
        if (l.status != null) s[`l${i + 1}.status`] = l.status;
        if (l.duration_ms != null) s[`l${i + 1}.duration_ms`] = l.duration_ms;
      });
      break;
  }
  return s;
}

const SERIES_FIELD = /^(?:(error|warn|info)\.)?series@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
/** Resolve a report value's `field` against an evidence row. Undefined = unresolvable. */
export function resolveField(ev: Pick<Evidence, 'tool' | 'stats' | 'result'>, field: string): number | undefined {
  if (field in ev.stats) return ev.stats[field];
  const m = SERIES_FIELD.exec(field);
  if (!m) return undefined;
  const r: any = ev.result;
  const series: [string, number][] | undefined =
    ev.tool === 'query_metric' && !m[1] ? r?.series :
    ev.tool === 'log_volume' && m[1] ? r?.by_severity?.[m[1]]?.series : undefined;
  return series?.find(([t]) => t === m[2])?.[1];
}
