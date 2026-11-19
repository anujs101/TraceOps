import { METRIC_TEMPLATES, QueryMetricChecked, QueryMetricInput, type MetricName } from '@traceops/contracts';
import { promQueryRange } from './backend/index.ts';
import { sanitizeBackendError } from './errors.ts';
import { METRIC_STEP_S, renderMetricQuery, stepFor } from './render.ts';
import type { ToolDef } from './runtime.ts';
import { capPoints, maxAt, parseSamples, seriesStats } from './series.ts';

const METRIC_LIST = (Object.entries(METRIC_TEMPLATES) as [MetricName, { unit: string }][]).map(([k, v]) => `${k} (${v.unit})`).join(', ');

export const queryMetricTool: ToolDef = {
  name: 'query_metric',
  description:
    'Read one metric for the affected service over a time window and get its min/max/avg/first/last and a series of at most 60 points. ' +
    `Metrics: ${METRIC_LIST}. ` +
    'window is "incident" (the period around the symptoms), "baseline" (the equal period just before it), or an explicit {start, end} in ISO 8601 with a zone, at most 60 minutes.',
  input: QueryMetricInput,
  checked: QueryMetricChecked,

  render: (a, _w, service) => renderMetricQuery(a.metric, service),

  async execute(a, w, query, { ctx, deps, id }) {
    const metric = a.metric as MetricName;
    const step = stepFor(w, METRIC_STEP_S);
    const base = { evidence_id: id, metric, unit: METRIC_TEMPLATES[metric].unit, window: w, step_s: step };

    const r = await promQueryRange({ baseUrl: ctx.prometheusUrl, query, start: w.start, end: w.end, stepS: step }, deps);
    if (!r.ok) {
      return {
        aborted: r.kind === 'aborted',
        output: { ...base, status: 'error', stats: null, max_at: null, series: [], error: sanitizeBackendError('prometheus', r) },
      };
    }
    // Templates aggregate to a single series; anything else is not described by the contract.
    const series = capPoints(parseSamples(r.data[0]?.values ?? []));
    if (series.length === 0) {
      return { output: { ...base, status: 'empty', stats: null, max_at: null, series: [], error: null } };
    }
    return { output: { ...base, status: 'ok', stats: seriesStats(series), max_at: maxAt(series), series, error: null } };
  },
};
