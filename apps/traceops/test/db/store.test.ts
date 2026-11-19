import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Groq from 'groq-sdk';
import { ISO_UTC_MS, Incident, LlmCall } from '@traceops/contracts';
import { migrate } from '../../src/db/migrate.ts';
import { PgInvestigationStore } from '../../src/db/store.ts';
import { MemoryRecorder, RecordingProvider, toLlmCallRow } from '../../src/llm/index.ts';
import { GroqProvider } from '../../src/llm/groq/adapter.ts';
import { FakeGroqClient, textResponse } from '../llm/fakes.ts';
import { evidence as fixtureEvidence, firstLiveReport } from '../fixtures/first-live-report.ts';
import { DB_URL, createTestDb, seedIncident, type TestDb } from './helpers.ts';

describe.skipIf(!DB_URL)('db: schema, store and llm_calls (real Postgres)', () => {
  let db: TestDb;
  let store: PgInvestigationStore;
  beforeAll(async () => { db = await createTestDb(); store = new PgInvestigationStore(db.pool); });
  afterAll(async () => { await db?.drop(); });

  const newInvestigation = async () => {
    const incidentId = await seedIncident(db.pool);
    return store.createInvestigation({ incidentId, jobId: null, trigger: 'manual', model: 'openai/gpt-oss-20b' });
  };

  it('migrations are idempotent', async () => {
    expect(await migrate(db.pool)).toEqual([]);
    const t = await db.pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [db.schema]);
    expect(t.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(
      ['incidents', 'investigation_jobs', 'investigations', 'evidence', 'reports', 'llm_calls', 'scenario_runs']));
  });

  describe('incidents', () => {
    it('a duplicate open incident for one fingerprint is impossible (partial unique index)', async () => {
      await seedIncident(db.pool, { service: 'svc-a', group: 'dup' });
      await expect(seedIncident(db.pool, { service: 'svc-a', group: 'dup' })).rejects.toMatchObject({ code: '23505' });
    });
    it('a resolved incident does not block a new open one, and concurrent opens produce exactly one', async () => {
      await seedIncident(db.pool, { service: 'svc-b', group: 'g', status: 'resolved' });
      const results = await Promise.allSettled(Array.from({ length: 8 }, () => seedIncident(db.pool, { service: 'svc-b', group: 'g' })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });
    it('reads return valid Incident records with IsoUtcMs times', async () => {
      const id = await seedIncident(db.pool, { status: 'resolved' });
      const inc = await store.getIncident(id);
      expect(Incident.safeParse(inc).success).toBe(true);
      expect(inc).toMatchObject({ status: 'resolved', started_at: '2026-11-16T18:25:00.000Z', resolved_at: '2026-11-16T18:35:00.000Z', reopen_count: 0 });
      for (const t of [inc!.started_at, inc!.detected_at, inc!.resolved_at!]) expect(t).toMatch(ISO_UTC_MS);
      expect((await store.listIncidents()).some((i) => i.id === id)).toBe(true);
      expect(await store.getIncident(randomUUID())).toBeNull();
    });
  });

  describe('investigations, evidence, reports', () => {
    it('evidence round-trips, is ordered numerically and is bound to its investigation', async () => {
      const inv = await newInvestigation();
      const sink = store.evidenceSink(inv.id);
      const rows = [...fixtureEvidence.map((e) => ({ ...e, investigation_id: inv.id })),
        { ...fixtureEvidence[0]!, id: 'ev_10', investigation_id: inv.id }];
      for (const r of [rows[4]!, ...rows.slice(0, 4)]) await sink.append(r); // insertion order != id order
      const back = await store.listEvidence(inv.id);
      expect(back.map((e) => e.id)).toEqual(['ev_1', 'ev_2', 'ev_3', 'ev_4', 'ev_10']);
      expect(back[0]).toEqual(rows[0]);
      await expect(sink.append({ ...rows[0]!, id: 'ev_1' })).rejects.toMatchObject({ code: '23505' }); // append-only keys
      await expect(sink.append({ ...rows[0]!, id: 'ev_11', investigation_id: randomUUID() })).rejects.toThrow(/another investigation/);
    });

    it('a null window and null args survive a round trip', async () => {
      const inv = await newInvestigation();
      const e = { ...fixtureEvidence[0]!, id: 'ev_1', investigation_id: inv.id, args: null, window: null, status: 'error' as const, error: 'invalid_input: x', result: null, stats: {} };
      await store.evidenceSink(inv.id).append(e);
      expect((await store.listEvidence(inv.id))[0]).toEqual(e);
    });

    it('reports save, upsert and read back; completed needs a report row', async () => {
      const inv = await newInvestigation();
      await expect(store.finishInvestigation(inv.id, { status: 'completed', toolCalls: 4, error: null })).rejects.toThrow(/reports row/);
      const row = { investigation_id: inv.id, report: firstLiveReport, validation: 'failed' as const, violations: [], warnings: [], repair_attempted: true };
      await store.reportSink(inv.id).save(row);
      await store.reportSink(inv.id).save({ ...row, validation: 'passed' });
      expect(await store.getReport(inv.id)).toEqual({ ...row, validation: 'passed' });
      await store.finishInvestigation(inv.id, { status: 'completed', toolCalls: 4, error: null });
      const done = await store.getInvestigation(inv.id);
      expect(done).toMatchObject({ status: 'completed', tool_calls: 4, error: null });
      expect(done!.finished_at).toMatch(ISO_UTC_MS);
      expect(await store.getReport(randomUUID())).toBeNull();
    });

    it('requestCancel flips cancel_requested; listInvestigations is per incident', async () => {
      const inv = await newInvestigation();
      expect((await store.getInvestigation(inv.id))!.cancel_requested).toBe(false);
      await store.requestCancel(inv.id);
      expect((await store.getInvestigation(inv.id))!.cancel_requested).toBe(true);
      expect((await store.listInvestigations(inv.incident_id)).map((i) => i.id)).toEqual([inv.id]);
    });

    it('enqueueManual uses a fresh incident:<id>:manual:<uuid> key each time', async () => {
      const incidentId = await seedIncident(db.pool);
      const a = await store.enqueueManual(incidentId);
      const b = await store.enqueueManual(incidentId);
      expect(a).not.toBe(b);
      const r = await db.pool.query('SELECT idempotency_key, status FROM investigation_jobs WHERE incident_id = $1', [incidentId]);
      expect(r.rows).toHaveLength(2);
      for (const k of r.rows) expect(k).toMatchObject({ status: 'queued', idempotency_key: expect.stringMatching(new RegExp(`^incident:${incidentId}:manual:[0-9a-f-]{36}$`)) });
    });
    it('failRunningForJob closes only this job\'s running investigations as failed(worker_lost)', async () => {
      const incidentId = await seedIncident(db.pool);
      const jobA = await store.enqueueManual(incidentId);
      const jobB = await store.enqueueManual(incidentId);
      const stale = await store.createInvestigation({ incidentId, jobId: jobA, trigger: 'manual', model: 'm' });
      const done = await store.createInvestigation({ incidentId, jobId: jobA, trigger: 'manual', model: 'm' });
      await store.finishInvestigation(done.id, { status: 'cancelled', toolCalls: 0, error: null });
      const other = await store.createInvestigation({ incidentId, jobId: jobB, trigger: 'manual', model: 'm' });

      expect(await store.failRunningForJob(jobA)).toBe(1);
      expect(await store.getInvestigation(stale.id)).toMatchObject({ status: 'failed', error: 'worker_lost', finished_at: expect.stringMatching(ISO_UTC_MS) });
      expect(await store.getInvestigation(done.id)).toMatchObject({ status: 'cancelled', error: null });
      expect(await store.getInvestigation(other.id)).toMatchObject({ status: 'running' });
      expect(await store.failRunningForJob(jobA)).toBe(0); // idempotent: first attempt of a job is a no-op
    });
  });

  describe('llm_calls', () => {
    const records = async (invId: string) => {
      const rl = () => { throw Groq.APIError.generate(429, { error: { message: 'rl' } }, undefined, new Headers({ 'retry-after': '1' })); };
      const noUsage = { ...textResponse('ok'), usage: undefined };
      const rec = new MemoryRecorder();
      const p = new RecordingProvider(new GroqProvider(new FakeGroqClient([textResponse('a'), rl, noUsage]), { model: 'openai/gpt-oss-20b', reasoningEffort: null }), rec);
      for (const turn of [1, 2, 3]) {
        await p.chat({ stage: 'investigate', trace: { investigationId: invId, turn }, messages: [], tools: [], maxOutputTokens: 8 }).catch(() => {});
      }
      return rec.records;
    };

    it('toLlmCallRow() output inserts without error and reads back identical', async () => {
      const inv = await newInvestigation();
      const recs = await records(inv.id);
      const inserted: LlmCall[] = [];
      for (const r of recs) inserted.push(await store.insertLlmCall(r));
      expect(inserted.map((r) => [r.status, r.error_kind, r.input_tokens])).toEqual([['ok', null, 100], ['error', 'rate_limit', null], ['ok', null, null]]);
      expect(await store.listLlmCalls(inv.id)).toEqual(inserted);
      for (const c of await store.listLlmCalls(inv.id)) expect(LlmCall.safeParse(c).success).toBe(true);
    });

    // raw SQL, so the database CHECKs are exercised rather than zod
    const raw = async (invId: string, o: Record<string, unknown>) => {
      const base = toLlmCallRow((await records(invId))[0]!);
      const c: Record<string, unknown> = { ...base, id: randomUUID(), turn: 9, ...o };
      return db.pool.query(
        `INSERT INTO llm_calls (id, investigation_id, turn, attempt, provider, model, stage, kind, status, input_tokens, output_tokens, latency_ms, stop_reason, error_kind, error_message, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [c.id, c.investigation_id, c.turn, c.attempt, c.provider, c.model, c.stage, c.kind, c.status, c.input_tokens, c.output_tokens, c.latency_ms, c.stop_reason, c.error_kind, c.error_message, c.created_at]);
    };

    it('CHECK rejects an ok row with an error_kind', async () => {
      const inv = await newInvestigation();
      await expect(raw(inv.id, { status: 'ok', error_kind: 'rate_limit' })).rejects.toMatchObject({ code: '23514' });
    });
    it('CHECK rejects an ok row without a stop_reason', async () => {
      const inv = await newInvestigation();
      await expect(raw(inv.id, { status: 'ok', stop_reason: null })).rejects.toMatchObject({ code: '23514' });
    });
    it('CHECK rejects an error row without an error_kind, or with token counts', async () => {
      const inv = await newInvestigation();
      await expect(raw(inv.id, { status: 'error', error_kind: null, input_tokens: null, output_tokens: null })).rejects.toMatchObject({ code: '23514' });
      await expect(raw(inv.id, { status: 'error', error_kind: 'server', input_tokens: 5, output_tokens: null })).rejects.toMatchObject({ code: '23514' });
    });
    it('accepts a well-formed error row, and rejects a duplicate (investigation, turn, attempt)', async () => {
      const inv = await newInvestigation();
      await raw(inv.id, { status: 'error', error_kind: 'server', input_tokens: null, output_tokens: null, stop_reason: null, error_message: 'x' });
      await expect(raw(inv.id, { status: 'error', error_kind: 'server', input_tokens: null, output_tokens: null, stop_reason: null })).rejects.toMatchObject({ code: '23505' });
    });
    it('CHECK rejects error_message over 300 chars and a turn below 1', async () => {
      const inv = await newInvestigation();
      await expect(raw(inv.id, { status: 'error', error_kind: 'server', input_tokens: null, output_tokens: null, stop_reason: null, error_message: 'x'.repeat(301) })).rejects.toMatchObject({ code: '23514' });
      await expect(raw(inv.id, { turn: 0 })).rejects.toMatchObject({ code: '23514' });
    });
  });
});
