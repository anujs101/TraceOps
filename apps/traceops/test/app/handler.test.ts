/**
 * Worker → job handler → D's investigate() on real Postgres, with the scripted provider and the
 * fixture-backed tools (no network, no LLM). Checks the rows the API and the UI will read.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Evidence, Incident, LlmCall } from '@traceops/contracts';
import { PgInvestigationStore } from '../../src/db/store.ts';
import { Worker } from '../../src/queue/worker.ts';
import { LlmError, RecordingProvider } from '../../src/llm/index.ts';
import { makeInvestigate } from '../../src/investigator/investigate.ts';
import { jobTrigger, makeJobHandler, shouldRetry } from '../../src/app/handler.ts';
import { logPatternsOutput, queryMetricOutput } from '../../scripts/lib/fixture-evidence.ts';
import { fixtureCreateTools, INVESTIGATION_START, S1_INCIDENT, ScriptedProvider, type Step } from '../investigator/fakes.ts';
import { DB_URL, createTestDb, seedJob, type TestDb } from '../db/helpers.ts';

const usedMax = queryMetricOutput('pool_used').stats!.max;
const p1Count = logPatternsOutput().patterns[0]!.count;
const VALID_REPORT = {
  status: 'probable_cause',
  summary: 'Database connection pool exhaustion caused the latency alert.',
  observations: [
    { id: 'obs_1', statement: 'Connections in use reached {used_max}.', evidence_ids: ['ev_1'], values: [{ key: 'used_max', evidence_id: 'ev_1', field: 'max', value: usedMax }] },
    { id: 'obs_2', statement: 'The top log pattern is a connection timeout, seen {p1_count} times.', evidence_ids: ['ev_3'], values: [{ key: 'p1_count', evidence_id: 'ev_3', field: 'p1.count', value: p1Count }] },
  ],
  hypotheses: [{ id: 'hyp_1', category: 'db_pool_exhaustion', statement: 'Connections leak until the pool is exhausted.', confidence: 'high', supporting_observation_ids: ['obs_1', 'obs_2'], contradicting_observation_ids: [] }],
  timeline: [],
  recommendations: [{ action: 'Release connections on every code path.', rationale: 'Stops the leak.', hypothesis_id: 'hyp_1', risk: 'low' }],
  gaps: [],
};
const TOOL_TURNS: Step[] = [
  { kind: 'chat', toolCalls: [{ name: 'query_metric', args: { metric: 'pool_used', window: 'incident' } }] },
  { kind: 'chat', toolCalls: [
    { name: 'search_logs', args: { window: 'incident', severity: 'error', match: { field: 'exception_message', contains: 'timeout' }, limit: 5 } },
    { name: 'log_patterns', args: { window: 'incident', severity: null } },
  ] },
  { kind: 'chat', content: 'Pool exhausted; timeouts in logs.' },
];
const quiet = () => {};

describe('handler: pure rules', () => {
  it('trigger comes from the idempotency key', () => {
    expect(jobTrigger('incident:x:auto')).toBe('auto');
    expect(jobTrigger('incident:x:manual:5f0c')).toBe('manual');
  });
  it('retry only infrastructure failures (persistence.md §2)', () => {
    const o = (status: 'completed' | 'failed' | 'cancelled', error: string | null) => ({ status, error, toolCalls: 0, report: null });
    expect(shouldRetry(o('failed', 'llm_rate_limit: slow down'))).toBe(true);
    expect(shouldRetry(o('failed', 'llm_server: 502'))).toBe(true);
    expect(shouldRetry(o('failed', 'connection terminated unexpectedly'))).toBe(true); // DB / tool layer
    expect(shouldRetry(o('failed', 'llm_auth: invalid key'))).toBe(false);
    expect(shouldRetry(o('failed', 'llm_bad_request: x'))).toBe(false);
    expect(shouldRetry(o('completed', null))).toBe(false);
    expect(shouldRetry(o('cancelled', null))).toBe(false);
  });
});

describe.skipIf(!DB_URL)('handler: worker → investigate → Postgres', () => {
  let db: TestDb;
  let store: PgInvestigationStore;
  beforeAll(async () => { db = await createTestDb(); store = new PgInvestigationStore(db.pool); });
  afterAll(async () => { await db?.drop(); });
  // each test claims exactly its own job: retire anything an earlier test left claimable
  beforeEach(async () => { await db.pool.query(`UPDATE investigation_jobs SET status = 'dead' WHERE status IN ('queued', 'running')`); });

  async function seedS1Incident(): Promise<Incident> {
    const id = randomUUID();
    const inc: Incident = { ...S1_INCIDENT, id, fingerprint: createHash('sha256').update(id).digest('hex') };
    await db.pool.query(
      `INSERT INTO incidents (id, fingerprint, service, "group", status, severity, started_at, detected_at, resolved_at, reopen_count, "trigger")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [inc.id, inc.fingerprint, inc.service, inc.group, inc.status, inc.severity, inc.started_at, inc.detected_at, inc.resolved_at, inc.reopen_count, JSON.stringify(inc.trigger)]);
    return inc;
  }

  function worker(steps: Step[]) {
    const scripted = new ScriptedProvider(steps);
    const handler = makeJobHandler({
      store, investigate: makeInvestigate({ pacing: null, sleep: async () => {} }), createTools: fixtureCreateTools().create,
      makeProvider: (recorder) => new RecordingProvider(scripted, recorder),
      prometheusUrl: 'http://prometheus.invalid', lokiUrl: 'http://loki.invalid',
      now: () => new Date(INVESTIGATION_START), log: quiet,
    });
    return new Worker({ pool: db.pool, handler, pollMs: 20, retryBaseMs: 1, log: quiet });
  }
  const jobRow = async (id: string) => (await db.pool.query('SELECT status, attempts FROM investigation_jobs WHERE id = $1', [id])).rows[0];

  it('a completed investigation: job done; investigation, evidence, report and llm_calls rows persisted', async () => {
    const inc = await seedS1Incident();
    const jobId = await seedJob(db.pool, inc.id);
    expect(await worker([...TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]).runOnce()).toBe('done');
    expect(await jobRow(jobId)).toMatchObject({ status: 'done', attempts: 1 });

    const [inv] = await store.listInvestigations(inc.id);
    expect(inv).toMatchObject({ job_id: jobId, trigger: 'auto', status: 'completed', model: 'fake-model', tool_calls: 3, error: null });
    const ev = await store.listEvidence(inv!.id);
    expect(ev.map((e) => [e.id, e.tool, e.status])).toEqual([['ev_1', 'query_metric', 'ok'], ['ev_2', 'search_logs', 'ok'], ['ev_3', 'log_patterns', 'ok']]);
    for (const e of ev) expect(Evidence.safeParse(e).success).toBe(true);
    expect(await store.getReport(inv!.id)).toMatchObject({ validation: 'passed', repair_attempted: false });
    const calls = await store.listLlmCalls(inv!.id);
    expect(calls.map((c) => [c.turn, c.stage, c.kind, c.status])).toEqual([
      [1, 'investigate', 'chat', 'ok'], [2, 'investigate', 'chat', 'ok'], [3, 'investigate', 'chat', 'ok'], [4, 'report', 'structured', 'ok']]);
    for (const c of calls) expect(LlmCall.safeParse(c).success).toBe(true);
  });

  it('a report failing validation is still completed and never retried', async () => {
    const inc = await seedS1Incident();
    const jobId = await seedJob(db.pool, inc.id);
    const bad = { ...VALID_REPORT, observations: [{ ...VALID_REPORT.observations[0]!, statement: 'Connections in use reached 10 ({used_max}).' }, VALID_REPORT.observations[1]!] };
    expect(await worker([...TOOL_TURNS, { kind: 'structured', value: bad }, { kind: 'structured', value: bad }]).runOnce()).toBe('done');
    const [inv] = await store.listInvestigations(inc.id);
    expect(inv!.status).toBe('completed');
    expect(await store.getReport(inv!.id)).toMatchObject({ validation: 'failed', repair_attempted: true });
    expect(await jobRow(jobId)).toMatchObject({ status: 'done' });
  });

  it('a retryable LLM failure requeues the job; the failed attempt keeps its llm_calls rows', async () => {
    const inc = await seedS1Incident();
    const jobId = await seedJob(db.pool, inc.id);
    const e429 = { kind: 'chat_error', error: new LlmError('rate_limit', 'slow down', { status: 429, retryAfterMs: 10 }) } as const;
    expect(await worker([e429, e429, e429, e429]).runOnce()).toBe('requeued');
    expect(await jobRow(jobId)).toMatchObject({ status: 'queued', attempts: 1 });
    const [inv] = await store.listInvestigations(inc.id);
    expect(inv).toMatchObject({ status: 'failed', error: expect.stringMatching(/^llm_rate_limit:/) });
    const calls = await store.listLlmCalls(inv!.id);
    expect(calls.map((c) => [c.attempt, c.status, c.error_kind])).toEqual([[1, 'error', 'rate_limit'], [2, 'error', 'rate_limit'], [3, 'error', 'rate_limit'], [4, 'error', 'rate_limit']]);
  });

  it('a non-retryable LLM failure (auth) finishes the job: investigation failed, not retried', async () => {
    const inc = await seedS1Incident();
    const jobId = await seedJob(db.pool, inc.id);
    expect(await worker([{ kind: 'chat_error', error: new LlmError('auth', 'invalid api key', { status: 401 }) }]).runOnce()).toBe('done');
    expect(await jobRow(jobId)).toMatchObject({ status: 'done' });
    const [inv] = await store.listInvestigations(inc.id);
    expect(inv).toMatchObject({ status: 'failed', error: expect.stringMatching(/^llm_auth:/) });
  });

  it('on reclaim, a lost worker\'s running investigation is closed as failed(worker_lost) before the new attempt', async () => {
    const inc = await seedS1Incident();
    const jobId = await seedJob(db.pool, inc.id);
    // attempt 1 claimed by a worker that then died: running job with an expired lease and a running investigation
    await db.pool.query(`UPDATE investigation_jobs SET status='running', attempts=1, lease_until=now() - interval '1 second' WHERE id = $1`, [jobId]);
    const lost = await store.createInvestigation({ incidentId: inc.id, jobId, trigger: 'auto', model: 'fake-model' });

    expect(await worker([...TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]).runOnce()).toBe('done');
    expect(await store.getInvestigation(lost.id)).toMatchObject({ status: 'failed', error: 'worker_lost' });
    const invs = await store.listInvestigations(inc.id);
    expect(invs.map((i) => i.status).sort()).toEqual(['completed', 'failed']);
    expect(await jobRow(jobId)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('a cancel requested mid-run ends the investigation cancelled and the job done', async () => {
    const inc = await seedS1Incident();
    await seedJob(db.pool, inc.id);
    const scripted = new ScriptedProvider([...TOOL_TURNS, { kind: 'structured', value: VALID_REPORT }]);
    const handler = makeJobHandler({
      store, investigate: makeInvestigate({ pacing: null, sleep: async () => {} }),
      createTools: (ctx) => fixtureCreateTools().create(ctx).map((t) => ({ ...t, run: async (a: unknown, c: any) => { await store.requestCancel(ctx.investigationId); return t.run(a, c); } })),
      makeProvider: (recorder) => new RecordingProvider(scripted, recorder),
      prometheusUrl: 'http://p.invalid', lokiUrl: 'http://l.invalid', now: () => new Date(INVESTIGATION_START), log: quiet,
    });
    expect(await new Worker({ pool: db.pool, handler, pollMs: 20, retryBaseMs: 1, log: quiet }).runOnce()).toBe('done');
    const [inv] = await store.listInvestigations(inc.id);
    expect(inv).toMatchObject({ status: 'cancelled', cancel_requested: true });
  });
});
