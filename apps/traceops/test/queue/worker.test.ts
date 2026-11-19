import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Worker, type Job } from '../../src/queue/index.ts';
import { DB_URL, createTestDb, seedIncident, seedJob, type TestDb } from '../db/helpers.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean>, ms = 3000) {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(10); }
}

describe.skipIf(!DB_URL)('worker loop against real Postgres', () => {
  let db: TestDb;
  let incidentId: string;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE incidents, investigation_jobs CASCADE');
    incidentId = await seedIncident(db.pool);
  });

  const quiet = () => {};
  const mk = (handler: (j: Job) => Promise<void>, o: { pollMs?: number; heartbeatMs?: number } = {}) =>
    new Worker({ pool: db.pool, handler, pollMs: 20, log: quiet, ...o });
  const row = async (id: string) => (await db.pool.query('SELECT *, lease_until - now() AS lease_left FROM investigation_jobs WHERE id = $1', [id])).rows[0];
  const status = async (id: string) => (await row(id)).status;
  const left = (i: any) => (i.minutes ?? 0) * 60 + (i.seconds ?? 0);

  it('defaults: idle poll every 1 s, heartbeat every 30 s', () => {
    const w = new Worker({ pool: db.pool, handler: async () => {}, log: quiet }) as any;
    expect([w.pollMs, w.heartbeatMs]).toEqual([1000, 30_000]);
  });

  it('idle when the queue is empty', async () => {
    expect(await mk(async () => {}).runOnce()).toBe('idle');
  });

  it('runs the injected handler with the claimed job and marks it done', async () => {
    const id = await seedJob(db.pool, incidentId);
    const seen: Job[] = [];
    expect(await mk(async (j) => { seen.push(j); }).runOnce()).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ id, incident_id: incidentId, status: 'running', attempts: 1 });
    expect(await row(id)).toMatchObject({ status: 'done', lease_until: null });
  });

  it('a throwing handler requeues the job once, then it is dead after the second attempt', async () => {
    const id = await seedJob(db.pool, incidentId);
    let calls = 0;
    const w = mk(async () => { calls++; throw new Error(`infra down #${calls}`); });
    expect(await w.runOnce()).toBe('requeued');
    expect(await row(id)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'infra down #1' });
    expect(await w.runOnce()).toBe('dead');
    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 2, last_error: 'infra down #2' });
    expect(await w.runOnce()).toBe('idle');
    expect(calls).toBe(2);
  });

  it('a handler that resolves is never retried, whatever the investigation outcome was', async () => {
    // validation:failed / insufficient_evidence are completed investigations: the handler resolves.
    const id = await seedJob(db.pool, incidentId);
    let calls = 0;
    const w = mk(async () => { calls++; });
    await w.runOnce();
    expect(await w.runOnce()).toBe('idle');
    expect([calls, await status(id)]).toEqual([1, 'done']);
  });

  it('attempts > max_attempts: marked dead after the claim and the handler is NOT run', async () => {
    const id = await seedJob(db.pool, incidentId);
    // crashed twice already: attempt 2 was running when its lease expired
    await db.pool.query(`UPDATE investigation_jobs SET status='running', attempts=2, lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    let calls = 0;
    expect(await mk(async () => { calls++; }).runOnce()).toBe('lease_exhausted');
    expect(calls).toBe(0);
    expect(await row(id)).toMatchObject({ status: 'dead', attempts: 3 });
    expect((await row(id)).last_error).toMatch(/lease expired after 2 attempts/);
  });

  it('a job whose first attempt crashed (lease expired) is run again as attempt 2', async () => {
    const id = await seedJob(db.pool, incidentId);
    await db.pool.query(`UPDATE investigation_jobs SET status='running', attempts=1, lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const seen: number[] = [];
    expect(await mk(async (j) => { seen.push(j.attempts); }).runOnce()).toBe('done');
    expect(seen).toEqual([2]);
  });

  it('heartbeats while the handler runs, extending the lease', async () => {
    const id = await seedJob(db.pool, incidentId);
    let during = 0;
    const w = mk(async () => {
      await db.pool.query(`UPDATE investigation_jobs SET lease_until = now() + interval '5 seconds' WHERE id = $1`, [id]); // as if the lease were running down
      await sleep(150);
      during = left((await row(id)).lease_left);
    }, { heartbeatMs: 20 });
    await w.runOnce();
    expect(during).toBeGreaterThan(290);
  });

  it('start() picks up jobs enqueued later; stop() waits for the job in flight and then stops claiming', async () => {
    const w = mk(async () => { await sleep(100); });
    w.start();
    const a = await seedJob(db.pool, incidentId, 'a');
    await until(async () => (await status(a)) === 'running');
    await w.stop(); // must wait for a to finish
    expect(await status(a)).toBe('done');
    const b = await seedJob(db.pool, incidentId, 'b');
    await sleep(120);
    expect(await status(b)).toBe('queued');
  });

  it('one worker runs jobs one at a time; two workers handle every job exactly once', async () => {
    for (let i = 0; i < 8; i++) await seedJob(db.pool, incidentId, `j${i}`);
    let active = 0, maxActive = 0;
    const handled: string[] = [];
    const h = async (j: Job) => { active++; maxActive = Math.max(maxActive, active); await sleep(10); handled.push(j.id); active--; };
    const w1 = mk(h), w2 = mk(h);
    w1.start(); w2.start();
    await until(async () => (await db.pool.query(`SELECT count(*)::int AS n FROM investigation_jobs WHERE status='done'`)).rows[0].n === 8);
    await Promise.all([w1.stop(), w2.stop()]);
    expect(handled).toHaveLength(8);
    expect(new Set(handled).size).toBe(8);
    expect(maxActive).toBeLessThanOrEqual(2); // one per worker
  });

  it('the loop survives a failing iteration (log, keep polling)', async () => {
    const errors: string[] = [];
    const w = new Worker({ pool: db.pool, handler: async () => {}, pollMs: 20, log: (l, m) => { if (l === 'error') errors.push(m); } });
    const orig = w.runOnce.bind(w);
    let n = 0;
    w.runOnce = async () => { if (n++ === 0) throw new Error('db blip'); return orig(); };
    w.start();
    const id = await seedJob(db.pool, incidentId);
    await until(async () => (await status(id)) === 'done');
    await w.stop();
    expect(errors).toEqual(['worker iteration failed']);
  });
});
