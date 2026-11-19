import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';

export const autoJobKey = (incidentId: string): string => `incident:${incidentId}:auto`;

/**
 * persistence.md §2: `ON CONFLICT DO NOTHING` on the idempotency key.
 * Returns the new job id, or null when a job with this key already exists.
 * Takes any Queryable so the detector can enqueue inside its incident transaction.
 */
export async function enqueueJob(q: Queryable, incidentId: string, idempotencyKey: string): Promise<string | null> {
  const r = await q.query(
    `INSERT INTO investigation_jobs (id, incident_id, idempotency_key, status)
     VALUES ($1, $2, $3, 'queued') ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [randomUUID(), incidentId, idempotencyKey]);
  return r.rows[0]?.id ?? null;
}
