import { LogVolumeChecked, LogVolumeInput, SEVERITIES } from '@traceops/contracts';
import { lokiQueryMatrix } from './backend/index.ts';
import { sanitizeBackendError } from './errors.ts';
import { VOLUME_STEP_S, renderVolumeQuery, stepFor } from './render.ts';
import type { ToolDef } from './runtime.ts';
import { capPoints, parseSamples, seriesStats, seriesSum, type Point, type SeriesStats } from './series.ts';

export const logVolumeTool: ToolDef = {
  name: 'log_volume',
  description:
    'Log lines per minute for the affected service over a window, split by severity (error, warn, info): min/max/avg/first/last/sum and a series of at most 60 points per severity. ' +
    'A severity with no lines in the window is absent, not zero. ' +
    'window is "incident", "baseline", or an explicit {start, end} in ISO 8601 with a zone, at most 60 minutes.',
  input: LogVolumeInput,
  checked: LogVolumeChecked,

  render: (_a, _w, service) => renderVolumeQuery(service),

  async execute(_a, w, query, { ctx, deps, id }) {
    const step = stepFor(w, VOLUME_STEP_S);
    const r = await lokiQueryMatrix({ baseUrl: ctx.lokiUrl, query, start: w.start, end: w.end, stepS: step }, deps);
    if (!r.ok) {
      return { aborted: r.kind === 'aborted', output: { evidence_id: id, status: 'error', window: w, step_s: step, by_severity: {}, error: sanitizeBackendError('loki', r) } };
    }
    // Only the three contract severities: STATS_KEY_GRAMMAR cannot cite anything else.
    const by_severity: Record<string, { stats: SeriesStats & { sum: number }; series: Point[] }> = {};
    for (const sev of SEVERITIES) {
      const found = r.data.find((s) => s.metric.severity_text === sev);
      const series = capPoints(parseSamples(found?.values ?? []));
      if (series.length) by_severity[sev] = { stats: { ...seriesStats(series), sum: seriesSum(series) }, series };
    }
    const status = Object.keys(by_severity).length ? 'ok' : 'empty';
    return { output: { evidence_id: id, status, window: w, step_s: step, by_severity, error: null } };
  },
};
