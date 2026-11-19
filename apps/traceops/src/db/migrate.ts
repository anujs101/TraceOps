import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type pg from 'pg';
import { createPool, withTransaction } from './pool.ts';

const MIGRATIONS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'migrations');

/** Applies `NNN_name.sql` files in order, each in its own transaction, once. Returns the names applied now. */
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    const sql = await readFile(join(dir, f), 'utf8');
    const did = await withTransaction(pool, async (c) => {
      // serialise concurrent runners
      await c.query('SELECT pg_advisory_xact_lock(7461636501)');
      const seen = await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f]);
      if (seen.rowCount) return false;
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      return true;
    });
    if (did) applied.push(f);
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createPool();
  migrate(pool)
    .then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date'))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(() => pool.end());
}
