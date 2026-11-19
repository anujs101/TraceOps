import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Evidence, Incident, LlmCall } from '@traceops/contracts';
import { MemoryStore } from '../../src/api/memory-store.ts';
import { startApi } from '../../src/api/server.ts';
import { INV_FAILED, INV_RUNNING, INV_UNVALIDATED, INV_VALIDATED, seedS1 } from '../../src/api/dev/seed-s1.ts';
import { S1_INCIDENT } from '../investigator/fakes.ts';

let server: Server;
let base: string;
const store = new MemoryStore();

beforeAll(async () => {
  await seedS1(store);
  server = await startApi(store, { port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const get = async (p: string, init?: RequestInit) => { const r = await fetch(base + p, init); return { status: r.status, body: await r.json() as any, headers: r.headers }; };
const post = (p: string) => get(p, { method: 'POST' });

describe('seed (real investigate() over S1 fixtures)', () => {
  it('produces a validated report, an unvalidated one, a failed and a running investigation', async () => {
    const validated = await store.getReport(INV_VALIDATED);
    expect(validated?.violations).toEqual([]);
    expect(validated).toMatchObject({ validation: 'passed', repair_attempted: false });
    expect(await store.getReport(INV_UNVALIDATED)).toMatchObject({ validation: 'failed', repair_attempted: true });
    expect((await store.getReport(INV_UNVALIDATED))!.violations.map((v) => v.rule)).toEqual(expect.arrayContaining(['V3', 'V5']));
    expect(await store.getInvestigation(INV_UNVALIDATED)).toMatchObject({ status: 'completed' });
    expect(await store.getInvestigation(INV_FAILED)).toMatchObject({ status: 'failed', tool_calls: 0 });
    expect(await store.getReport(INV_FAILED)).toBeNull();
    expect(await store.getInvestigation(INV_RUNNING)).toMatchObject({ status: 'running' });
  });
});

describe('GET endpoints', () => {
  it('health', async () => { expect(await get('/api/health')).toMatchObject({ status: 200, body: { status: 'ok' } }); });

  it('lists incidents (contract-shaped)', async () => {
    const r = await get('/api/incidents');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(() => Incident.parse(r.body[0])).not.toThrow();
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('gets one incident and its investigations, newest first', async () => {
    expect((await get(`/api/incidents/${S1_INCIDENT.id}`)).body.id).toBe(S1_INCIDENT.id);
    const r = await get(`/api/incidents/${S1_INCIDENT.id}/investigations`);
    expect(r.body.map((i: any) => i.id)).toHaveLength(4);
    expect(r.body[0].id).toBe(INV_RUNNING);
  });

  it('evidence rows are contract Evidence, in order', async () => {
    const r = await get(`/api/investigations/${INV_VALIDATED}/evidence`);
    expect(r.body.map((e: any) => e.id)).toEqual(['ev_1', 'ev_2', 'ev_3', 'ev_4', 'ev_5', 'ev_6', 'ev_7', 'ev_8']);
    for (const e of r.body) expect(() => Evidence.parse(e)).not.toThrow();
    expect(r.body[0].rendered_query).toContain('histogram_quantile');
  });

  it('report and llm_calls', async () => {
    const rep = await get(`/api/investigations/${INV_VALIDATED}/report`);
    expect(rep.body).toMatchObject({ investigation_id: INV_VALIDATED, validation: 'passed' });
    const calls = await get(`/api/investigations/${INV_VALIDATED}/llm-calls`);
    for (const c of calls.body) expect(() => LlmCall.parse(c)).not.toThrow();
    expect(calls.body.map((c: any) => c.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls.body.at(-1)).toMatchObject({ stage: 'report', kind: 'structured' });
  });

  it('report is 404 until one exists', async () => {
    expect((await get(`/api/investigations/${INV_RUNNING}/report`)).status).toBe(404);
  });

  it('404 for unknown ids and paths; 405 for wrong method', async () => {
    expect((await get('/api/incidents/nope')).status).toBe(404);
    expect((await get('/api/incidents/nope/investigations')).status).toBe(404);
    expect((await get('/api/investigations/nope/evidence')).status).toBe(404);
    expect((await get('/api/investigations/nope/llm-calls')).status).toBe(404);
    expect((await get('/api/whatever')).status).toBe(404);
    expect((await get('/api/incidents', { method: 'POST' })).status).toBe(405);
    expect((await get(`/api/investigations/${INV_RUNNING}/cancel`)).status).toBe(405);
  });
});

describe('POST endpoints', () => {
  it('rerun enqueues a manual job with the contract idempotency key', async () => {
    const r = await post(`/api/incidents/${S1_INCIDENT.id}/rerun`);
    expect(r.status).toBe(202);
    const job = store.jobs.at(-1)!;
    expect(r.body.job_id).toBe(job.id);
    expect(job.idempotency_key).toMatch(new RegExp(`^incident:${S1_INCIDENT.id}:manual:[0-9a-f-]{36}$`));
    expect((await post('/api/incidents/nope/rerun')).status).toBe(404);
  });

  it('cancel sets cancel_requested on a running investigation; 409 otherwise', async () => {
    expect(await post(`/api/investigations/${INV_VALIDATED}/cancel`)).toMatchObject({ status: 409, body: { error: 'not_running' } });
    expect((await post(`/api/investigations/${INV_RUNNING}/cancel`)).status).toBe(202);
    expect((await store.getInvestigation(INV_RUNNING))!.cancel_requested).toBe(true);
    expect((await post('/api/investigations/nope/cancel')).status).toBe(404);
  });
});

describe('hardening', () => {
  it('CORS only for the UI origin', async () => {
    expect((await get('/api/health', { headers: { origin: 'http://localhost:5173' } })).headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect((await get('/api/health', { headers: { origin: 'http://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('store errors become a generic 500 without details', async () => {
    const broken = new MemoryStore();
    broken.listIncidents = async () => { throw new Error('connection string postgres://user:secret@db'); };
    const s = await startApi(broken, { port: 0 });
    try {
      const r = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/incidents`);
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(text).toBe('{"error":"internal"}');
    } finally { await new Promise<void>((r) => s.close(() => r())); }
  });
});
