import crypto from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import type { PoolClient } from 'pg';
import type { Fault } from './config';

export type Logger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type AppDeps = {
  acquire: () => Promise<PoolClient>;
  log: Logger;
  fault: Fault;
  cpuIter: number;
};

/** telemetry.md §5. Log lines are fixed phrases; error text comes only from libraries. */
export function createApp({ acquire, log, fault, cpuIter }: AppDeps) {
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on('finish', () => {
      if (res.statusCode >= 500) return; // the error handler logs these as `request failed`
      const route = req.route?.path ?? req.path;
      log.info({ route, status: res.statusCode, duration_ms: Math.round(performance.now() - t0) }, 'request completed');
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/products', async (_req, res, next) => {
    try {
      if (fault === 'cpu_burn') crypto.pbkdf2Sync('pw', 'salt', cpuIter, 32, 'sha256');
      const client = await acquire();
      try {
        const { rows } = await client.query('SELECT id, stock FROM products ORDER BY id LIMIT 20');
        res.json(rows);
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  app.post('/orders', async (req, res, next) => {
    try {
      const { productId, qty = 1 } = req.body ?? {};
      const client = await acquire();
      const { rows } = await client.query('SELECT stock FROM products WHERE id = $1', [productId]);
      if (!rows[0] || rows[0].stock < qty) {
        log.warn({ route: '/orders', status: 409 }, 'order rejected');
        res.status(409).json({ error: 'insufficient stock' });
        // FAULT=pool_leak: this early return skips release(). The injected defect; nothing logs it.
        if (fault !== 'pool_leak') client.release();
        return;
      }
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO orders(product_id, qty) VALUES ($1, $2)', [productId, qty]);
        await client.query('COMMIT');
        res.status(201).json({ ok: true });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

  // Any error (including pool acquire timeouts) -> HTTP 500 + `request failed` with the error as `err`.
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    log.error({ err, route: req.route?.path ?? req.path, status: 500 }, 'request failed');
    res.status(500).json({ error: 'internal error' });
  };
  app.use(onError);

  return app;
}
