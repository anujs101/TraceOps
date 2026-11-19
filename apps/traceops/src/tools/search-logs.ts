import { LIMITS, SearchLogsChecked, SearchLogsInput } from '@traceops/contracts';
import { lokiQueryLogs } from './backend/index.ts';
import { sanitizeBackendError } from './errors.ts';
import { toLogLine } from './loglines.ts';
import { renderLogQuery } from './render.ts';
import type { ToolDef } from './runtime.ts';

export const searchLogsTool: ToolDef = {
  name: 'search_logs',
  description:
    'Fetch individual log lines (newest first) for the affected service. Optional filters: severity (error, warn, info), and match = a case-insensitive substring of the log message or of the exception message. ' +
    'limit is 1-50 (default 20). Each line has timestamp, message, severity_text, exception_type, exception_message, route, status, duration_ms and service_version. ' +
    'window is "incident", "baseline", or an explicit {start, end} in ISO 8601 with a zone, at most 60 minutes.',
  input: SearchLogsInput,
  checked: SearchLogsChecked,

  render: (a, _w, service) => renderLogQuery(service, { severity: a.severity, match: a.match }),

  async execute(a, w, query, { ctx, deps, id }) {
    const limit: number = a.limit ?? LIMITS.searchLogsDefaultLimit;
    const r = await lokiQueryLogs({ baseUrl: ctx.lokiUrl, query, start: w.start, end: w.end, limit }, deps);
    if (!r.ok) {
      return { aborted: r.kind === 'aborted', output: { evidence_id: id, status: 'error', window: w, lines: [], truncated: false, error: sanitizeBackendError('loki', r) } };
    }
    const lines = r.data.slice(0, limit).map(toLogLine);
    return {
      output: { evidence_id: id, status: lines.length ? 'ok' : 'empty', window: w, lines, truncated: r.data.length >= limit, error: null },
    };
  },
};
