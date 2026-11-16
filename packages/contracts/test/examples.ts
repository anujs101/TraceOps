// Hand-written examples that exercise the schemas. Real backend shapes live in fixtures/.
import type { Report } from '../src/report.ts';

export const queryMetricOut = {
  evidence_id: 'ev_1', status: 'ok', metric: 'pool_used', unit: 'connections',
  window: { start: '2026-11-16T18:02:00.000Z', end: '2026-11-16T18:06:00.000Z' }, step_s: 15,
  stats: { min: 1, max: 10, avg: 6.2, first: 1, last: 10, points: 3 },
  max_at: '2026-11-16T18:05:00.000Z',
  series: [['2026-11-16T18:04:30.000Z', 4], ['2026-11-16T18:04:45.000Z', 8], ['2026-11-16T18:05:00.000Z', 10]],
  error: null,
};

export const logVolumeOut = {
  evidence_id: 'ev_2', status: 'ok', window: { start: '2026-11-16T18:02:00.000Z', end: '2026-11-16T18:06:00.000Z' }, step_s: 60,
  by_severity: {
    error: { stats: { min: 0, max: 12, avg: 7.75, first: 0, last: 12, points: 4, sum: 31 },
      series: [['2026-11-16T18:03:00.000Z', 0], ['2026-11-16T18:04:00.000Z', 7], ['2026-11-16T18:05:00.000Z', 12], ['2026-11-16T18:06:00.000Z', 12]] },
    info: { stats: { min: 1500, max: 1800, avg: 1650, first: 1800, last: 1500, points: 2, sum: 3300 },
      series: [['2026-11-16T18:03:00.000Z', 1800], ['2026-11-16T18:04:00.000Z', 1500]] },
  },
  error: null,
};

export const logPatternsOut = {
  evidence_id: 'ev_3', status: 'ok', window: { start: '2026-11-16T18:02:00.000Z', end: '2026-11-16T18:06:00.000Z' }, sampled_lines: 46,
  patterns: [
    { rank: 1, severity_text: 'error', message: 'request failed', exception_message: 'timeout exceeded when trying to connect', count: 31,
      first_at: '2026-11-16T18:04:02.120Z', last_at: '2026-11-16T18:05:58.004Z', service_versions: ['1.0.1'] },
    { rank: 2, severity_text: 'warn', message: 'order rejected', exception_message: null, count: 15,
      first_at: '2026-11-16T18:02:10.000Z', last_at: '2026-11-16T18:05:40.000Z', service_versions: ['1.0.0', '1.0.1'] },
  ],
  error: null,
};

export const searchLogsOut = {
  evidence_id: 'ev_4', status: 'ok', window: { start: '2026-11-16T18:02:00.000Z', end: '2026-11-16T18:06:00.000Z' },
  lines: [{ timestamp: '2026-11-16T18:04:02.120Z', message: 'request failed', severity_text: 'error', exception_type: 'Error',
    exception_message: 'timeout exceeded when trying to connect', route: '/orders', status: 500, duration_ms: null, service_version: '1.0.1' }],
  truncated: false, error: null,
};

export const validReport: Report = {
  status: 'probable_cause',
  summary: 'Connection pool exhausted after the deploy; acquisitions time out and requests fail with HTTP 500.',
  observations: [
    { id: 'obs_1', statement: 'Connections in use rose to {used_max} of {pool_max} and stayed there', evidence_ids: ['ev_1'],
      values: [{ key: 'used_max', evidence_id: 'ev_1', field: 'max', value: 10 }, { key: 'pool_max', evidence_id: 'ev_1', field: 'last', value: 10 }] },
    { id: 'obs_2', statement: '{timeout_errors} error logs report "timeout exceeded when trying to connect", all from v1.0.1', evidence_ids: ['ev_3'],
      values: [{ key: 'timeout_errors', evidence_id: 'ev_3', field: 'p1.count', value: 31 }] },
  ],
  hypotheses: [{ id: 'hyp_1', category: 'db_pool_exhaustion', statement: 'Connections are not returned to the pool after the 1.0.1 deploy',
    confidence: 'high', supporting_observation_ids: ['obs_1', 'obs_2'], contradicting_observation_ids: [] }],
  timeline: [{ at: '2026-11-16T18:04:02.120Z', event: 'first acquire-timeout error', evidence_ids: ['ev_3'] }],
  recommendations: [{ action: 'Roll back to 1.0.0', rationale: 'Stops further connection loss', hypothesis_id: 'hyp_1', risk: 'low' }],
  gaps: ['Code changes in 1.0.1 were not inspected (no code tool in MVP)'],
};
