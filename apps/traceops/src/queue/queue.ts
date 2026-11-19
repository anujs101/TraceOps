import { toIsoUtcMs } from '@traceops/contracts';
import type { Queryable } from '../db/pool.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

/** investigation_jobs row, times as IsoUtcMs. */
export type Job = {
  id: string;
  incident_id: string;
  idempotency_key: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export function mapJob(r: any): Job {
  return {
    id: r.id, incident_id: r.incident_id, idempotency_key: r.idempotency_key, status: r.status, attempts: r.attempts,
    max_attempts: r.max_attempts, lease_until: r.lease_until ? toIsoUtcMs(r.lease_until) : null, last_error: r.last_error,
    created_at: toIsoUtcMs(r.created_at), updated_at: toIsoUtcMs(r.updated_at),
  };
}

/** persistence.md §2, verbatim. A running job whose lease expired is reclaimed (attempts is incremented again). */
export const CLAIM_SQL = `UPDATE investigation_jobs SET status='running', attempts=attempts+1,
       lease_until=now()+interval '5 minutes', updated_at=now()
WHERE id = (SELECT id FROM investigation_jobs
            WHERE status='queued' OR (status='running' AND lease_until < now())
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;`;

export async function claimJob(q: Queryable): Promise<Job | null> {
  const r = await q.query(CLAIM_SQL);
  return r.rows[0] ? mapJob(r.rows[0]) : null;
}

/**
 * Every follow-up statement below is tied to the claim that produced `attempts`: a reclaim
 * increments it, so a worker whose lease expired can no longer extend, finish or requeue the
 * job that someone else now owns.
 *
 * Extend the lease by another 5 minutes. False if the claim is gone (job not running, or reclaimed).
 */
export async function heartbeat(q: Queryable, jobId: string, attempts: number): Promise<boolean> {
  const r = await q.query(
    `UPDATE investigation_jobs SET lease_until = now() + interval '5 minutes', updated_at = now()
     WHERE id = $1 AND status = 'running' AND attempts = $2`, [jobId, attempts]);
  return (r.rowCount ?? 0) > 0;
}

export async function completeJob(q: Queryable, jobId: string, attempts: number): Promise<boolean> {
  const r = await q.query(
    `UPDATE investigation_jobs SET status = 'done', lease_until = NULL, updated_at = now()
     WHERE id = $1 AND status = 'running' AND attempts = $2`, [jobId, attempts]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Infrastructure failure: failed → queued while attempts < max_attempts, else dead
 * (persistence.md §3). `failed` is transient, so the two steps are one statement.
 * Returns the resulting status, or null if this claim no longer holds the job.
 */
export async function failJob(q: Queryable, jobId: string, attempts: number, error: string): Promise<'queued' | 'dead' | null> {
  const r = await q.query(
    `UPDATE investigation_jobs
        SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'dead' END,
            lease_until = NULL, last_error = $2, updated_at = now()
      WHERE id = $1 AND status = 'running' AND attempts = $3 RETURNING status`,
    [jobId, error.slice(0, 1000), attempts]);
  return r.rows[0]?.status ?? null;
}

export async function markDead(q: Queryable, jobId: string, attempts: number, error: string): Promise<boolean> {
  const r = await q.query(
    `UPDATE investigation_jobs SET status = 'dead', lease_until = NULL, last_error = $2, updated_at = now()
     WHERE id = $1 AND status = 'running' AND attempts = $3`, [jobId, error.slice(0, 1000), attempts]);
  return (r.rowCount ?? 0) > 0;
}
