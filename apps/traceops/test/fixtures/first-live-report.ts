/**
 * The first live Groq report (smoke run 2026-11-16T18:54:40Z, gpt-oss-20b).
 *
 * PROVENANCE: the smoke script stored call metadata only, not model output, so
 * the full JSON was not persisted. obs_1 below is VERBATIM from the printed
 * sample; the hypotheses' categories/confidences are verbatim from the printed
 * summary; obs_2/obs_3 are RECONSTRUCTED around the exact offending tokens the
 * validator printed ("0.347", "0.0939", "100"). It reproduces the same 5 V3
 * violations and the unsupported high-confidence hypothesis.
 * (Live repair runs now persist raw outputs to apps/traceops/runs/, gitignored.)
 */
import type { Evidence } from '@traceops/contracts';

const W = { start: '2026-11-16T18:23:38.000Z', end: '2026-11-16T18:30:39.000Z' };
const INV = '00000000-0000-4000-8000-000000000001';
const metric = (id: string, metric: string, stats: Record<string, number>): Evidence => ({
  id, investigation_id: INV, tool: 'query_metric', source: 'prometheus', args: { metric }, rendered_query: null, window: W,
  status: 'ok', error: null, result: { metric, stats, series: [] }, stats, duration_ms: 0, created_at: W.end,
});

export const evidence: Evidence[] = [
  metric('ev_1', 'pool_used', { min: 0, max: 10, avg: 6.1, first: 0, last: 10, points: 29 }),
  metric('ev_2', 'pool_max', { min: 10, max: 10, avg: 10, first: 10, last: 10, points: 29 }),
  metric('ev_3', 'eventloop_utilization', { min: 0.0067, max: 0.347, avg: 0.0939, first: 0.11, last: 0.02, points: 29 }),
  {
    id: 'ev_4', investigation_id: INV, tool: 'log_patterns', source: 'loki', args: { window: 'incident' }, rendered_query: null, window: W,
    status: 'ok', error: null,
    result: { sampled_lines: 100, patterns: [{ rank: 1, severity_text: 'error', message: 'request failed', exception_message: 'timeout exceeded when trying to connect', count: 100, service_versions: ['1.0.1'] }] },
    stats: { sampled_lines: 100, 'p1.count': 100 }, duration_ms: 0, created_at: W.end,
  },
];

export const firstLiveReport = {
  status: 'probable_cause',
  summary: 'The connection pool saturated after the deploy, causing acquire timeouts and failing requests.',
  observations: [
    { id: 'obs_1', statement: 'The connection pool usage reached its maximum value of 10, matching the configured pool max of 10, indicating the pool was saturated.',
      evidence_ids: ['ev_1', 'ev_2'], values: [{ key: 'pool_used_max', evidence_id: 'ev_1', field: 'max', value: 10 }, { key: 'pool_max_value', evidence_id: 'ev_2', field: 'max', value: 10 }] },
    { id: 'obs_2', statement: 'Event loop utilization peaked at 0.347 with an average of 0.0939, so the event loop was not saturated.',
      evidence_ids: ['ev_3'], values: [{ key: 'el_max', evidence_id: 'ev_3', field: 'max', value: 0.347 }, { key: 'el_avg', evidence_id: 'ev_3', field: 'avg', value: 0.0939 }] },
    { id: 'obs_3', statement: 'All 100 sampled error logs report "timeout exceeded when trying to connect".',
      evidence_ids: ['ev_4'], values: [{ key: 'timeout_logs', evidence_id: 'ev_4', field: 'p1.count', value: 100 }] },
  ],
  hypotheses: [
    { id: 'hyp_1', category: 'db_pool_exhaustion', statement: 'The connection pool reached capacity, causing request blocking and increased latency.', confidence: 'medium', supporting_observation_ids: ['obs_1', 'obs_3'], contradicting_observation_ids: [] },
    { id: 'hyp_2', category: 'dependency_latency', statement: 'A slow downstream dependency held connections longer than usual.', confidence: 'high', supporting_observation_ids: ['obs_1'], contradicting_observation_ids: ['obs_2'] },
  ],
  timeline: [{ at: '2026-11-16T18:26:00.000Z', event: 'first acquire-timeout errors', evidence_ids: ['ev_4'] }],
  recommendations: [{ action: 'Roll back the deploy', rationale: 'Stops connection loss', hypothesis_id: 'hyp_1', risk: 'low' }],
  gaps: ['Code changes were not inspected'],
};

/** A correct repair of the above: placeholders bound, hyp_2 confidence lowered. */
export const repairedReport = {
  ...firstLiveReport,
  observations: [
    { ...firstLiveReport.observations[0]!, statement: 'Connection pool usage reached {pool_used_max}, equal to the configured maximum of {pool_max_value}.' },
    { ...firstLiveReport.observations[1]!, statement: 'Event-loop utilization peaked at {el_max} with an average of {el_avg}; the event loop was not saturated.' },
    { ...firstLiveReport.observations[2]!, statement: 'All {timeout_logs} sampled error logs report "timeout exceeded when trying to connect".' },
  ],
  hypotheses: [firstLiveReport.hypotheses[0]!, { ...firstLiveReport.hypotheses[1]!, confidence: 'low' }],
};
