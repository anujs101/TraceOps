import pg from 'pg';

// timestamptz → Date is the pg default; the store converts to IsoUtcMs. int8 stays a string (we have none).
export function createPool(url: string | undefined = process.env.TRACEOPS_DATABASE_URL): pg.Pool {
  if (!url) throw new Error('TRACEOPS_DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url, max: 10 });
}

export type Queryable = Pick<pg.Pool, 'query'>;

/** Run `fn` in one transaction on a dedicated connection; rolls back on throw. */
export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
