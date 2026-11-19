import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ISO_UTC_MS } from '@traceops/contracts';
import { CLAIM_SQL, autoJobKey, claimJob, completeJob, enqueueJob, failJob, heartbeat, markDead } from '../../src/queue/index.ts';
import { DB_URL, createTestDb, seedIncident, seedJob, type TestDb } from '../db/helpers.ts';

describe.skipIf(!DB_URL)('queue against real Postgres (persistence.md §2)', () => {
  let db: TestDb;
  let incidentId: string;
  beforeAll(async () => { db = await createTestDb(); });
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE incidents, investigation_jobs CASCADE');
    incidentId = await seedIncident(db.pool);
  });

  const row = async (id: string) => (await db.pool.query('SELECT *, lease_until - now() AS lease_left FROM investigation_jobs WHERE id = $1', [id])).rows[0];
  const expire = (id: string, attempts: number) => db.pool.query(
    `UPDATE investigation_jobs SET status = 'running', attempts = $2, lease_until = now() - interval '1 second' WHERE id = $1`, [id, attempts]);
  const secs = (i: any) => (i.minutes ?? 0) * 60 + (i.seconds ?? 0);

  it('uses the claim query of persistence.md §2 (FOR UPDATE SKIP LOCKED, 5 minute lease)', () => {
    expect(CLAIM_SQL).toContain('FOR UPDATE SKIP LOCKED LIMIT 1');
    expect(CLAIM_SQL).toContain(`status='queued' OR (status='running' AND lease_until < now())`);
    expect(CLAIM_SQL).toContain(`interval '5 minutes'`);
    expect(CLAIM_SQL).toContain('ORDER BY created_at');
  });

  describe('enqueue', () => {
    it('is idempotent on the key (ON CONFLICT DO NOTHING)', async () => {
      const a = await enqueueJob(db.pool, incidentId, autoJobKey(incidentId));
      const b = await enqueueJob(db.pool, incidentId, autoJobKey(incidentId));
      expect(a).toMatch(/^[0-9a-f-]{36}$/);
      expect(b).toBeNull();
      expect((await db.pool.query('SELECT count(*)::int AS n FROM investigation_jobs')).rows[0].n).toBe(1);
      expect(await row(a!)).toMatchObject({ status: 'queued', attempts: 0, max_attempts: 2, lease_until: null, idempotency_key: `incident:${incidentId}:auto` });
    });
    it('concurrent identical enqueues create one job', async () => {
      const r = await Promise.all(Array.from({ length: 10 }, () => enqueueJob(db.pool, incidentId, 'incident:x:auto')));
      expect(r.filter(Boolean)).toHaveLength(1);
    });
  });

  describe('claim', () => {
    it('returns null when there is nothing to claim', async () => {
      expect(await claimJob(db.pool)).toBeNull();
    });

    it('moves a queued job to running, attempts 1, with a ~5 minute lease; times are IsoUtcMs', async () => {
      const id = await seedJob(db.pool, incidentId);
      const job = await claimJob(db.pool);
      expect(job).toMatchObject({ id, status: 'running', attempts: 1, max_attempts: 2, incident_id: incidentId });
      for (const t of [job!.lease_until!, job!.created_at, job!.updated_at]) expect(t).toMatch(ISO_UTC_MS);
      const left = secs((await row(id)).lease_left);
      expect(left).toBeGreaterThan(290);
      expect(left).toBeLessThanOrEqual(300);
    });

    it('claims oldest first', async () => {
      const ids = [await seedJob(db.pool, incidentId, 'k1'), await seedJob(db.pool, incidentId, 'k2'), await seedJob(db.pool, incidentId, 'k3')];
      await db.pool.query(`UPDATE investigation_jobs SET created_at = now() - interval '3 minutes' WHERE id = $1`, [ids[2]]);
      await db.pool.query(`UPDATE investigation_jobs SET created_at = now() - interval '2 minutes' WHERE id = $1`, [ids[0]]);
      await db.pool.query(`UPDATE investigation_jobs SET created_at = now() - interval '1 minutes' WHERE id = $1`, [ids[1]]);
      const order = [(await claimJob(db.pool))!.id, (await claimJob(db.pool))!.id, (await claimJob(db.pool))!.id];
      expect(order).toEqual([ids[2], ids[0], ids[1]]);
    });

    it('does not claim a running job with a live lease, nor done or dead jobs', async () => {
      const a = await seedJob(db.pool, incidentId, 'a'); const b = await seedJob(db.pool, incidentId, 'b'); const c = await seedJob(db.pool, incidentId, 'c');
      await db.pool.query(`UPDATE investigation_jobs SET status='running', lease_until = now() + interval '1 minute' WHERE id = $1`, [a]);
      await db.pool.query(`UPDATE investigation_jobs SET status='done' WHERE id = $1`, [b]);
      await db.pool.query(`UPDATE investigation_jobs SET status='dead' WHERE id = $1`, [c]);
      expect(await claimJob(db.pool)).toBeNull();
    });

    it('two concurrent claims never get the same job (1 job, 20 concurrent claimers)', async () => {
      const id = await seedJob(db.pool, incidentId);
      const got = await Promise.all(Array.from({ length: 20 }, () => claimJob(db.pool)));
      expect(got.filter(Boolean).map((j) => j!.id)).toEqual([id]);
      expect((await row(id)).attempts).toBe(1);
    });

    it('many jobs, many concurrent workers: every job claimed exactly once', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 30; i++) ids.add(await seedJob(db.pool, incidentId, `m${i}`));
      const claimed: string[] = [];
      await Promise.all(Array.from({ length: 8 }, async () => {
        for (let j = await claimJob(db.pool); j; j = await claimJob(db.pool)) claimed.push(j.id);
      }));
      expect(claimed).toHaveLength(30);
      expect(new Set(claimed)).toEqual(ids);
      expect((await db.pool.query('SELECT DISTINCT attempts FROM investigation_jobs')).rows).toEqual([{ attempts: 1 }]);
    });

    it('SKIP LOCKED: a job row locked by another transaction is skipped, not waited for', async () => {
      const oldest = await seedJob(db.pool, incidentId, 'old');
      const next = await seedJob(db.pool, incidentId, 'next');
      await db.pool.query(`UPDATE investigation_jobs SET created_at = now() - interval '1 minute' WHERE id = $1`, [oldest]);
      const holder = await db.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM investigation_jobs WHERE id = $1 FOR UPDATE', [oldest]); // e.g. a claim in flight
        const t0 = Date.now();
        const claimed = await Promise.race([
          claimJob(db.pool),
          new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1500)),
        ]);
        expect(claimed).not.toBe('blocked');
        expect(claimed).toMatchObject({ id: next, attempts: 1 });
        expect(Date.now() - t0).toBeLessThan(1000);
        expect((await row(oldest)).status).toBe('queued'); // untouched
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((await claimJob(db.pool))!.id).toBe(oldest); // claimable once unlocked
    });

    it('an expired lease is reclaimed, and attempts increments again', async () => {
      const id = await seedJob(db.pool, incidentId);
      await claimJob(db.pool);
      expect(await claimJob(db.pool)).toBeNull(); // lease still live
      await expire(id, 1);
      const again = await claimJob(db.pool);
      expect(again).toMatchObject({ id, status: 'running', attempts: 2 });
      expect(secs((await row(id)).lease_left)).toBeGreaterThan(290); // fresh lease
    });

    it('a lease that expired and is reclaimed by two racing workers goes to exactly one', async () => {
      const id = await seedJob(db.pool, incidentId);
      await expire(id, 1);
      const got = await Promise.all(Array.from({ length: 10 }, () => claimJob(db.pool)));
      expect(got.filter(Boolean)).toHaveLength(1);
      expect((await row(id)).attempts).toBe(2);
    });
  });

  describe('heartbeat, complete, fail', () => {
    it('heartbeat extends the lease by 5 minutes; false when the job is not running', async () => {
      const id = await seedJob(db.pool, incidentId);
      await claimJob(db.pool);
      await db.pool.query(`UPDATE investigation_jobs SET lease_until = now() + interval '10 seconds' WHERE id = $1`, [id]);
      expect(await heartbeat(db.pool, id, 1)).toBe(true);
      expect(secs((await row(id)).lease_left)).toBeGreaterThan(290);
      await completeJob(db.pool, id, 1);
      expect(await heartbeat(db.pool, id, 1)).toBe(false);
      expect(await heartbeat(db.pool, randomUUID(), 1)).toBe(false);
    });

    it('complete → done, lease cleared; only from running', async () => {
      const id = await seedJob(db.pool, incidentId);
      expect(await completeJob(db.pool, id, 1)).toBe(false); // still queued
      await claimJob(db.pool);
      expect(await completeJob(db.pool, id, 1)).toBe(true);
      expect(await row(id)).toMatchObject({ status: 'done', lease_until: null });
    });

    it('fail: queued again while attempts < max_attempts, dead after the 2nd attempt', async () => {
      const id = await seedJob(db.pool, incidentId);
      await claimJob(db.pool);
      expect(await failJob(db.pool, id, 1, 'groq 503')).toBe('queued');
      expect(await row(id)).toMatchObject({ status: 'queued', attempts: 1, last_error: 'groq 503', lease_until: null });
      const second = await claimJob(db.pool);
      expect(second).toMatchObject({ id, attempts: 2 });
      expect(await failJob(db.pool, id, 2, 'groq 503 again')).toBe('dead');
      expect(await row(id)).toMatchObject({ status: 'dead', attempts: 2, last_error: 'groq 503 again' });
      expect(await claimJob(db.pool)).toBeNull(); // dead is never claimed
    });

    it('fail on a job that is not running changes nothing', async () => {
      const id = await seedJob(db.pool, incidentId);
      expect(await failJob(db.pool, id, 1, 'x')).toBeNull();
      expect(await row(id)).toMatchObject({ status: 'queued', last_error: null });
    });

    it('follow-ups are tied to the claim: a stale claimer cannot heartbeat, complete or fail a reclaimed job', async () => {
      const id = await seedJob(db.pool, incidentId);
      const a = await claimJob(db.pool); // attempt 1
      await expire(id, 1);
      const b = await claimJob(db.pool); // reclaimed: attempt 2
      expect([a!.attempts, b!.attempts]).toEqual([1, 2]);
      expect(await heartbeat(db.pool, id, 1)).toBe(false);
      expect(await completeJob(db.pool, id, 1)).toBe(false);
      expect(await failJob(db.pool, id, 1, 'stale')).toBeNull();
      expect(await markDead(db.pool, id, 1, 'stale')).toBe(false);
      expect(await row(id)).toMatchObject({ status: 'running', attempts: 2, last_error: null });
      expect(await heartbeat(db.pool, id, 2)).toBe(true);
      expect(await completeJob(db.pool, id, 2)).toBe(true);
      expect((await row(id)).status).toBe('done');
    });

    it('last_error is truncated, not rejected', async () => {
      const id = await seedJob(db.pool, incidentId);
      await claimJob(db.pool);
      await failJob(db.pool, id, 1, 'e'.repeat(5000));
      expect((await row(id)).last_error).toHaveLength(1000);
    });
  });
});
