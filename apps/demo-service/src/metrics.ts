import { metrics } from '@opentelemetry/api';
import type { Pool, PoolClient } from 'pg';

const POOL_ATTR = { 'db.client.connection.pool.name': 'main' };
const TIMEOUT_MESSAGE = /timeout exceeded when trying to connect/;

/**
 * Pool metrics that telemetry.md §3 assigns to the demo service (single source).
 * Gauges are observed at every export from the live pool, so a leaked pool still reports.
 * instrumentation-pg's own pool instruments are dropped by a View in otel.ts.
 * Returns the instrumented acquire function (wait time recorded on success AND failure).
 */
export function registerPoolMetrics(pool: Pool): () => Promise<PoolClient> {
  const meter = metrics.getMeter('demo-service-pool');
  const waitTime = meter.createHistogram('db.client.connection.wait_time', {
    unit: 's',
    advice: { explicitBucketBoundaries: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 5] },
  });
  const timeouts = meter.createCounter('db.client.connection.timeouts', { unit: '{timeout}' });
  const count = meter.createObservableUpDownCounter('db.client.connection.count', { unit: '{connection}' });
  const max = meter.createObservableUpDownCounter('db.client.connection.max', { unit: '{connection}' });
  const pending = meter.createObservableUpDownCounter('db.client.connection.pending_requests', { unit: '{request}' });
  meter.addBatchObservableCallback(
    (r) => {
      r.observe(count, pool.idleCount, { ...POOL_ATTR, 'db.client.connection.state': 'idle' });
      r.observe(count, pool.totalCount - pool.idleCount, { ...POOL_ATTR, 'db.client.connection.state': 'used' });
      r.observe(max, pool.options.max ?? 10, POOL_ATTR);
      r.observe(pending, pool.waitingCount, POOL_ATTR);
    },
    [count, max, pending],
  );

  return async function acquire(): Promise<PoolClient> {
    const t0 = performance.now();
    try {
      const client = await pool.connect();
      waitTime.record((performance.now() - t0) / 1000, POOL_ATTR);
      return client;
    } catch (err) {
      waitTime.record((performance.now() - t0) / 1000, POOL_ATTR);
      if (err instanceof Error && TIMEOUT_MESSAGE.test(err.message)) timeouts.add(1, POOL_ATTR);
      throw err;
    }
  };
}
