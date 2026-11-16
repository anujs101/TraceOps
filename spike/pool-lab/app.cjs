// SPIKE ONLY (pool lab): a throwaway service used to verify contract
// assumptions with a real pg pool. Not the demo-service implementation.
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { metrics } = require('@opentelemetry/api');
const log = require('pino')({ level: 'info' });

const FAULT = process.env.FAULT ?? 'none';
const CPU_ITER = Number(process.env.CPU_ITER ?? 20000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://lab:lab@localhost:5432/lab',
  max: 10, connectionTimeoutMillis: 2000, idleTimeoutMillis: 30000,
});

// Custom pool metrics NOT emitted by instrumentation-pg: acquire wait + timeouts.
const meter = metrics.getMeter('lab-pool');
const waitTime = meter.createHistogram('db.client.connection.wait_time', {
  unit: 's',
  advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 5] },
});
const timeouts = meter.createCounter('db.client.connection.timeouts', { unit: '{timeout}' });
const POOL_ATTR = { 'db.client.connection.pool.name': 'main' };

// Export-time observable pool gauges (fresh at every export, unlike event-driven counters).
const cCount = meter.createObservableUpDownCounter('db.client.connection.count', { unit: '{connection}' });
const cMax = meter.createObservableUpDownCounter('db.client.connection.max', { unit: '{connection}' });
const cPending = meter.createObservableUpDownCounter('db.client.connection.pending_requests', { unit: '{request}' });
meter.addBatchObservableCallback((r) => {
  r.observe(cCount, pool.idleCount, { ...POOL_ATTR, 'db.client.connection.state': 'idle' });
  r.observe(cCount, pool.totalCount - pool.idleCount, { ...POOL_ATTR, 'db.client.connection.state': 'used' });
  r.observe(cMax, pool.options.max, POOL_ATTR);
  r.observe(cPending, pool.waitingCount, POOL_ATTR);
}, [cCount, cMax, cPending]);

async function acquire() {
  const t0 = performance.now();
  try {
    const c = await pool.connect();
    waitTime.record((performance.now() - t0) / 1000, POOL_ATTR);
    return c;
  } catch (err) {
    waitTime.record((performance.now() - t0) / 1000, POOL_ATTR);
    if (/timeout exceeded when trying to connect/.test(err.message)) timeouts.add(1, POOL_ATTR);
    throw err;
  }
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  const t0 = performance.now();
  res.on('finish', () => {
    const route = req.route?.path ?? req.path;
    if (res.statusCode < 500) log.info({ route, status: res.statusCode, duration_ms: Math.round(performance.now() - t0) }, 'request completed');
  });
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/products', async (_req, res, next) => {
  try {
    if (FAULT === 'cpu_burn') crypto.pbkdf2Sync('pw', 'salt', CPU_ITER, 32, 'sha256');
    // Intermittent variant: a small share of requests block the loop for a long time.
    if (FAULT === 'cpu_spike' && Math.random() < Number(process.env.SPIKE_PROB ?? 0.03))
      crypto.pbkdf2Sync('pw', 'salt', CPU_ITER, 32, 'sha256');
    const c = await acquire();
    try { const { rows } = await c.query('SELECT id, stock FROM products ORDER BY id LIMIT 20'); res.json(rows); }
    finally { c.release(); }
  } catch (err) { next(err); }
});

app.post('/orders', async (req, res, next) => {
  try {
    const { productId, qty = 1 } = req.body ?? {};
    const c = await acquire();
    const { rows } = await c.query('SELECT stock FROM products WHERE id = $1', [productId]);
    if (!rows[0] || rows[0].stock < qty) {
      log.warn({ route: '/orders', status: 409 }, 'order rejected');
      res.status(409).json({ error: 'insufficient stock' });
      if (FAULT !== 'pool_leak') c.release(); // the injected bug: no release on this path
      return;
    }
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO orders(product_id, qty) VALUES ($1, $2)', [productId, qty]);
      await c.query('COMMIT');
      res.status(201).json({ ok: true });
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  } catch (err) { next(err); }
});

// Acquire timeout (or any error) -> HTTP 500 + structured error log with err.
app.use((err, req, res, _next) => {
  const route = req.route?.path ?? req.path;
  log.error({ err, route, status: 500 }, 'request failed');
  res.status(500).json({ error: 'internal error' });
});

(async () => {
  const c = await pool.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS products(id int primary key, stock int not null);
                 CREATE TABLE IF NOT EXISTS orders(id serial primary key, product_id int, qty int, at timestamptz default now());
                 INSERT INTO products(id, stock) SELECT g, CASE WHEN g <= 5 THEN 0 ELSE 1000000 END FROM generate_series(1,50) g
                 ON CONFLICT (id) DO UPDATE SET stock = EXCLUDED.stock;`);
  c.release();
  const server = app.listen(Number(process.env.PORT ?? 8080), () => log.info({ fault: FAULT }, 'service started'));
  const stop = async () => { server.close(); await globalThis.__otelShutdown(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})();
