import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction, type Queryable } from '../db/pool.ts';
import { autoJobKey, enqueueJob } from '../queue/enqueue.ts';

export type TriggerEntry = { rule_id: string; query: string; threshold: number; observed: number; at: string };

export type OpenRequest = {
  service: string;
  group: string;
  severity: 'critical' | 'warning';
  /** first breaching evaluation (earliest `since` among firing rules) */
  startedAt: string;
  /** the evaluation at which fire_after was reached */
  detectedAt: string;
  trigger: TriggerEntry[];
  reopenWindowS: number;
};

export type OpenResult = { action: 'opened' | 'updated' | 'reopened'; incidentId: string; jobId: string | null };

export type EnqueueFn = (q: Queryable, incidentId: string, key: string) => Promise<string | null>;

/** detection.md §4: fingerprint = sha256(service + ":" + group). */
export const fingerprintOf = (service: string, group: string): string =>
  createHash('sha256').update(`${service}:${group}`).digest('hex');

export class IncidentManager {
  constructor(private readonly pool: pg.Pool, private readonly enqueue: EnqueueFn = enqueueJob) {}

  /**
   * Open (+ enqueue, in the same transaction), update the open one, or reopen a
   * recently resolved one. The partial unique index makes a duplicate open impossible;
   * a race on it falls back to updating the incident that won.
   * Reopen keeps the contract-literal job key `incident:<id>:auto`, so it enqueues nothing new.
   */
  async openOrUpdate(req: OpenRequest): Promise<OpenResult> {
    const fp = fingerprintOf(req.service, req.group);
    const trigger = JSON.stringify(req.trigger);
    return withTransaction(this.pool, async (c) => {
      const update = async (id: string): Promise<OpenResult> => {
        await c.query('UPDATE incidents SET "trigger" = $2::jsonb, severity = $3 WHERE id = $1', [id, trigger, req.severity]);
        return { action: 'updated', incidentId: id, jobId: null };
      };

      const open = await c.query(`SELECT id FROM incidents WHERE fingerprint = $1 AND status = 'open' FOR UPDATE`, [fp]);
      if (open.rows[0]) return update(open.rows[0].id);

      const recent = await c.query(
        `SELECT id FROM incidents WHERE fingerprint = $1 AND status = 'resolved'
           AND resolved_at >= $2::timestamptz - make_interval(secs => $3)
         ORDER BY resolved_at DESC LIMIT 1 FOR UPDATE`,
        [fp, req.detectedAt, req.reopenWindowS]);
      if (recent.rows[0]) {
        const id: string = recent.rows[0].id;
        await c.query(
          `UPDATE incidents SET status = 'open', resolved_at = NULL, reopen_count = reopen_count + 1,
             "trigger" = $2::jsonb, severity = $3 WHERE id = $1`, [id, trigger, req.severity]);
        const jobId = await this.enqueue(c, id, autoJobKey(id)); // conflicts with the original key → null
        return { action: 'reopened', incidentId: id, jobId };
      }

      const id = randomUUID();
      const ins = await c.query(
        `INSERT INTO incidents (id, fingerprint, service, "group", status, severity, started_at, detected_at, resolved_at, reopen_count, "trigger")
         VALUES ($1,$2,$3,$4,'open',$5,$6,$7,NULL,0,$8::jsonb)
         ON CONFLICT (fingerprint) WHERE status = 'open' DO NOTHING RETURNING id`,
        [id, fp, req.service, req.group, req.severity, req.startedAt, req.detectedAt, trigger]);
      if (!ins.rows[0]) { // lost a race with another detector
        const won = await c.query(`SELECT id FROM incidents WHERE fingerprint = $1 AND status = 'open' FOR UPDATE`, [fp]);
        return update(won.rows[0].id);
      }
      const jobId = await this.enqueue(c, id, autoJobKey(id));
      return { action: 'opened', incidentId: id, jobId };
    });
  }

  /** Resolve the open incident of this group, if any. Returns its id. */
  async resolve(service: string, group: string, at: string): Promise<string | null> {
    const r = await this.pool.query(
      `UPDATE incidents SET status = 'resolved', resolved_at = $2 WHERE fingerprint = $1 AND status = 'open' RETURNING id`,
      [fingerprintOf(service, group), at]);
    return r.rows[0]?.id ?? null;
  }

  /** Groups that have an open incident (used to seed state after a restart). */
  async openGroups(): Promise<{ service: string; group: string }[]> {
    const r = await this.pool.query(`SELECT service, "group" FROM incidents WHERE status = 'open'`);
    return r.rows;
  }
}
