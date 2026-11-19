/**
 * DEV ONLY: seeds a MemoryStore with the S1 incident and investigations produced
 * by the REAL investigate() pipeline (tool loop → validator → repair), driven by
 * a scripted provider over the real S1 fixtures. Every number in the reports is
 * read from the fixture outputs, so the validator decides, not this file.
 *
 *  - INV_VALIDATED:   completed, validation passed
 *  - INV_UNVALIDATED: completed, validation failed after one repair (UI: "unvalidated")
 *  - INV_FAILED:      failed (LLM auth error, no report)
 *  - INV_RUNNING:     running (no report yet; cancel is allowed)
 */
import { deriveStats } from '@traceops/contracts';
import { LlmError, RecordingProvider, toLlmCallRow, type LlmCallRecord } from '../../llm/index.ts';
import { makeInvestigate } from '../../investigator/investigate.ts';
import { fixtureCreateTools, S1_INCIDENT, S1_INVESTIGATION_START } from '../../investigator/dev/fixture-tools.ts';
import { ScriptedProvider, type Step } from '../../investigator/dev/scripted-provider.ts';
import { logPatternsOutput, logVolumeOutput, queryMetricOutput, searchLogsOutput } from '../../../scripts/lib/fixture-evidence.ts';
import type { InvestigationRow } from '../../seams.ts';
import type { MemoryStore } from '../memory-store.ts';

export const INV_VALIDATED = '00000000-0000-4000-8000-0000000000b1';
export const INV_UNVALIDATED = '00000000-0000-4000-8000-0000000000b2';
export const INV_FAILED = '00000000-0000-4000-8000-0000000000b3';
export const INV_RUNNING = '00000000-0000-4000-8000-0000000000b4';
const MODEL = 'scripted-fixture';

/** The tool calls a good investigation makes; evidence ids follow this order (ev_1..ev_8). */
const TOOL_TURNS: Step[] = [
  { kind: 'chat', toolCalls: [{ name: 'query_metric', args: { metric: 'latency_p95', window: 'incident' } }] },
  { kind: 'chat', toolCalls: [
    { name: 'query_metric', args: { metric: 'pool_used', window: 'incident' } },
    { name: 'query_metric', args: { metric: 'pool_max', window: 'incident' } },
    { name: 'query_metric', args: { metric: 'pool_pending', window: 'incident' } },
  ] },
  { kind: 'chat', toolCalls: [{ name: 'query_metric', args: { metric: 'eventloop_utilization', window: 'incident' } }] },
  { kind: 'chat', toolCalls: [
    { name: 'search_logs', args: { window: 'incident', severity: 'error', match: { field: 'exception_message', contains: 'timeout' }, limit: 5 } },
    { name: 'log_patterns', args: { window: 'incident', severity: null } },
    { name: 'log_volume', args: { window: 'incident' } },
  ] },
  { kind: 'chat', content: 'Pool connections are all in use with requests queueing, errors are connection timeouts, and the event loop is mostly idle.' },
];

function s1Report() {
  const m = (metric: string) => queryMetricOutput(metric) as any;
  const lat = m('latency_p95'), used = m('pool_used'), max = m('pool_max'), pend = m('pool_pending'), elu = m('eventloop_utilization');
  const logs = searchLogsOutput(5) as any;
  const pat = logPatternsOutput() as any;
  const volStats = deriveStats('log_volume', logVolumeOutput());
  const volKey = Object.keys(volStats).find((k) => k.endsWith('.sum') && !k.startsWith('total')) ?? 'total.sum';
  return {
    status: 'probable_cause',
    summary: 'The database connection pool was exhausted: every connection stayed in use, requests queued for a connection and failed with connection timeouts, while the event loop stayed mostly idle.',
    observations: [
      { id: 'obs_1', statement: 'p95 latency rose to {lat_p95_max} seconds.', evidence_ids: ['ev_1'], values: [{ key: 'lat_p95_max', evidence_id: 'ev_1', field: 'max', value: lat.stats.max }] },
      {
        id: 'obs_2', statement: 'Connections in use reached {used_max} of a pool maximum of {pool_max}, with up to {pending_max} requests waiting for a connection.',
        evidence_ids: ['ev_2', 'ev_3', 'ev_4'],
        values: [
          { key: 'used_max', evidence_id: 'ev_2', field: 'max', value: used.stats.max },
          { key: 'pool_max', evidence_id: 'ev_3', field: 'max', value: max.stats.max },
          { key: 'pending_max', evidence_id: 'ev_4', field: 'max', value: pend.stats.max },
        ],
      },
      { id: 'obs_3', statement: 'Event loop utilization peaked at {elu_max}, so the process was not CPU bound.', evidence_ids: ['ev_5'], // rounded to 3 significant figures, as a model would write it; V2 accepts honest rounding
      values: [{ key: 'elu_max', evidence_id: 'ev_5', field: 'max', value: Number(elu.stats.max.toPrecision(3)) }] },
      {
        id: 'obs_4', statement: 'The most frequent log pattern is a connection timeout error, seen {p1_count} times; error logs total {err_sum} lines.',
        evidence_ids: ['ev_6', 'ev_7', 'ev_8'],
        values: [
          { key: 'p1_count', evidence_id: 'ev_7', field: 'p1.count', value: pat.patterns[0].count },
          { key: 'err_sum', evidence_id: 'ev_8', field: volKey, value: volStats[volKey] },
        ],
      },
    ],
    hypotheses: [
      {
        id: 'hyp_1', category: 'db_pool_exhaustion', confidence: 'high',
        statement: 'Connections are not returned to the pool, so the pool stays at {used_max} of {pool_max} and new requests time out waiting.',
        supporting_observation_ids: ['obs_2', 'obs_4', 'obs_1'], contradicting_observation_ids: [],
      },
      {
        id: 'hyp_2', category: 'cpu_saturation', confidence: 'low',
        statement: 'CPU saturation slows request handling.',
        supporting_observation_ids: ['obs_1'], contradicting_observation_ids: ['obs_3'],
      },
    ],
    timeline: [
      { at: logs.lines[0].timestamp, event: 'First connection timeout error logged.', evidence_ids: ['ev_6'] },
      { at: pend.max_at, event: 'Requests waiting for a pool connection peak.', evidence_ids: ['ev_4'] },
    ],
    recommendations: [
      { action: 'Release the database connection on every code path of the handler, including errors.', rationale: 'A leaked connection is never returned, which matches a pool pinned at its maximum.', hypothesis_id: 'hyp_1', risk: 'low' },
      { action: 'Alert on requests waiting for a pool connection.', rationale: 'Pending requests rise before latency and errors do.', hypothesis_id: 'hyp_1', risk: 'low' },
    ],
    gaps: ['Traces were not available, so the exact code path that holds connections is not identified.'],
  };
}

/** Deliberately broken: a bare number (V3) and a high-confidence hypothesis backed by metrics only (V5). */
function brokenReport() {
  const r = s1Report();
  return {
    ...r,
    observations: r.observations.map((o) => (o.id === 'obs_2' ? { ...o, statement: `${o.statement} The pool was full for 3 minutes.` } : o)),
    hypotheses: [{ ...r.hypotheses[0]!, supporting_observation_ids: ['obs_2'] }, r.hypotheses[1]!],
  };
}

async function run(store: MemoryStore, id: string, steps: Step[]): Promise<void> {
  const startedAt = S1_INVESTIGATION_START;
  const records: LlmCallRecord[] = [];
  const provider = new RecordingProvider(new ScriptedProvider(steps, { model: MODEL }), { record: (r) => records.push(r) });
  const base = Date.parse(startedAt);
  const row: InvestigationRow = {
    id, incident_id: S1_INCIDENT.id, job_id: null, status: 'running', trigger: id === INV_VALIDATED ? 'auto' : 'manual', model: MODEL,
    started_at: startedAt, finished_at: null, tool_calls: 0, cancel_requested: false, error: null,
  };
  store.putInvestigation(row);
  const out = await makeInvestigate({ sleep: async () => {} })({
    investigationId: id, incident: S1_INCIDENT, investigationStart: startedAt, provider,
    createTools: fixtureCreateTools({ now: () => base + 2000 }).create,
    evidence: store.evidenceSink(id), reports: store.reportSink(id),
    isCancelled: async () => false, prometheusUrl: 'http://fixture.invalid', lokiUrl: 'http://fixture.invalid',
  });
  for (const r of records) store.addLlmCall(toLlmCallRow({ ...r, startedAt: new Date(base + 1000 * (r.turn ?? 1)).toISOString() }));
  store.putInvestigation({ ...row, status: out.status, tool_calls: out.toolCalls, error: out.error, finished_at: new Date(base + 40_000).toISOString() });
}

export async function seedS1(store: MemoryStore): Promise<void> {
  store.addIncident(S1_INCIDENT);
  await run(store, INV_VALIDATED, [...TOOL_TURNS, { kind: 'structured', value: s1Report() }]);
  await run(store, INV_UNVALIDATED, [...TOOL_TURNS, { kind: 'structured', value: brokenReport() }, { kind: 'structured', value: brokenReport() }]);
  await run(store, INV_FAILED, [{ kind: 'chat_error', error: new LlmError('auth', 'invalid API key', { status: 401 }) }]);
  store.putInvestigation({
    id: INV_RUNNING, incident_id: S1_INCIDENT.id, job_id: null, status: 'running', trigger: 'manual', model: MODEL,
    started_at: new Date(Date.parse(S1_INVESTIGATION_START) + 60_000).toISOString(), finished_at: null, tool_calls: 0, cancel_requested: false, error: null,
  });
}
