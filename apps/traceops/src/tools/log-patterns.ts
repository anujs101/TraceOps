import { LIMITS, LogPatternsChecked, LogPatternsInput } from '@traceops/contracts';
import { lokiQueryLogs } from './backend/index.ts';
import { sanitizeBackendError } from './errors.ts';
import { toLogLine, type LogLine } from './loglines.ts';
import { renderLogQuery } from './render.ts';
import type { ToolDef } from './runtime.ts';
import { cleanOrNull, cleanString } from './redact.ts';

/** Collapse ids and numbers so lines that differ only by them group together (tools.md §5). */
export function normalise(s: string): string {
  return s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(?<![\w.\/-])\d+(?:\.\d+)*(?:ms|s|m|%)?(?![\w])/g, '<n>');
}

type Group = { severity: string; message: string; exception: string | null; count: number; first: string; last: string; versions: Set<string> };

export function groupLines(lines: LogLine[]): Group[] {
  const groups = new Map<string, Group>();
  for (const l of lines) {
    const message = cleanString(normalise(l.message));
    const exception = l.exception_message === null ? null : cleanString(normalise(l.exception_message));
    const key = JSON.stringify([l.severity_text, message, exception]);
    const g = groups.get(key) ?? { severity: l.severity_text, message, exception, count: 0, first: l.timestamp, last: l.timestamp, versions: new Set<string>() };
    g.count++;
    if (l.timestamp < g.first) g.first = l.timestamp;
    if (l.timestamp > g.last) g.last = l.timestamp;
    if (l.service_version) g.versions.add(l.service_version);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.first.localeCompare(b.first) || a.message.localeCompare(b.message));
}

export const logPatternsTool: ToolDef = {
  name: 'log_patterns',
  description:
    'Group the most recent log lines (up to 500) in a window into the most common message patterns, ranked by count, with first/last occurrence and the service versions seen. ' +
    'Numbers, ids and UUIDs in messages are normalised so repeats group together. Optional severity filter (error, warn, info). ' +
    'window is "incident", "baseline", or an explicit {start, end} in ISO 8601 with a zone, at most 60 minutes.',
  input: LogPatternsInput,
  checked: LogPatternsChecked,

  render: (a, _w, service) => renderLogQuery(service, { severity: a.severity, match: null }),

  async execute(a, w, query, { ctx, deps, id }) {
    const r = await lokiQueryLogs({ baseUrl: ctx.lokiUrl, query, start: w.start, end: w.end, limit: LIMITS.patternSampleLines }, deps);
    if (!r.ok) {
      return { aborted: r.kind === 'aborted', output: { evidence_id: id, status: 'error', window: w, sampled_lines: 0, patterns: [], error: sanitizeBackendError('loki', r) } };
    }
    const lines = r.data.slice(0, LIMITS.patternSampleLines).map(toLogLine);
    if (lines.length === 0) return { output: { evidence_id: id, status: 'empty', window: w, sampled_lines: 0, patterns: [], error: null } };
    const patterns = groupLines(lines).slice(0, LIMITS.patternTopN).map((g, i) => ({
      rank: i + 1, severity_text: g.severity, message: g.message, exception_message: cleanOrNull(g.exception),
      count: g.count, first_at: g.first, last_at: g.last, service_versions: [...g.versions].sort(),
    }));
    return { output: { evidence_id: id, status: 'ok', window: w, sampled_lines: lines.length, patterns, error: null } };
  },
};
