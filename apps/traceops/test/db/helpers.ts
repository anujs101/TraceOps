import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.ts';

export const DB_URL = process.env.TRACEOPS_DATABASE_URL;
export const NO_DB_MESSAGE = 'TRACEOPS_DATABASE_URL is not set: DB tests SKIPPED (a skip is not a pass)';
if (!DB_URL) console.warn(`\n[test/db] ${NO_DB_MESSAGE}\n`);

export type TestDb = { pool: pg.Pool; schema: string; drop(): Promise<void> };

/** A private schema per test file, so files can run in parallel against one database. */
export async function createTestDb(): Promise<TestDb> {
  if (!DB_URL) throw new Error(NO_DB_MESSAGE);
  const schema = `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: DB_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();
  const u = new URL(DB_URL);
  u.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: u.toString(), max: 10 });
  await migrate(pool);
  return {
    pool, schema,
    async drop() {
      await pool.end();
      const a = new pg.Pool({ connectionString: DB_URL, max: 1 });
      await a.query(`DROP SCHEMA ${schema} CASCADE`);
      await a.end();
    },
  };
}

export const fingerprint = (service: string, group: string) =>
  createHash('sha256').update(`${service}:${group}`).digest('hex');

export type SeedIncident = Partial<{ id: string; service: string; group: string; status: 'open' | 'resolved'; severity: 'critical' | 'warning'; startedAt: string; resolvedAt: string | null }>;

/** Direct SQL seed, independent of the code under test. */
export async function seedIncident(pool: pg.Pool, o: SeedIncident = {}): Promise<string> {
  const id = o.id ?? randomUUID();
  const service = o.service ?? 'demo-service';
  const group = o.group ?? `g-${id.slice(0, 8)}`;
  const status = o.status ?? 'open';
  await pool.query(
    `INSERT INTO incidents (id, fingerprint, service, "group", status, severity, started_at, detected_at, resolved_at, reopen_count, "trigger")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,0,$9::jsonb)`,
    [id, fingerprint(service, group), service, group, status, o.severity ?? 'warning', o.startedAt ?? '2026-11-16T18:25:00.000Z',
      status === 'resolved' ? (o.resolvedAt ?? '2026-11-16T18:35:00.000Z') : null,
      JSON.stringify([{ rule_id: 'http-latency-p95', query: 'latency_p95', threshold: 1, observed: 2.425, at: '2026-11-16T18:25:30.000Z' }])]);
  return id;
}

export async function seedJob(pool: pg.Pool, incidentId: string, key = `incident:${incidentId}:auto`): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO investigation_jobs (id, incident_id, idempotency_key, status) VALUES ($1,$2,$3,'queued')`, [id, incidentId, key]);
  return id;
}
