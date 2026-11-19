import { Pool } from 'pg';

/** telemetry.md §5: max 10, connectionTimeoutMillis 2000 (never 0), idleTimeoutMillis 30000. */
export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000 });
}

/** Schema + seed. Products 1-5 have zero stock (the 409 path); the rest are effectively unlimited. Idempotent. */
export async function initSchema(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS products(id int primary key, stock int not null);
      CREATE TABLE IF NOT EXISTS orders(id serial primary key, product_id int, qty int, at timestamptz default now());
      INSERT INTO products(id, stock) SELECT g, CASE WHEN g <= 5 THEN 0 ELSE 1000000 END FROM generate_series(1, 50) g
        ON CONFLICT (id) DO UPDATE SET stock = EXCLUDED.stock;
    `);
  } finally {
    c.release();
  }
}
