// Spike emitter (CommonJS). Run: OTEL_SEMCONV_STABILITY_OPT_IN=http node --require ./otel.cjs emit.cjs
const http = require('node:http');
const { metrics } = require('@opentelemetry/api');
const log = require('pino')({ level: 'info' });

// Planned pool instruments (OTel DB client semconv names).
const meter = metrics.getMeter('spike-pool');
const pool = { total: 10, idle: 7, waiting: 0 };
const poolCount = meter.createObservableUpDownCounter('db.client.connection.count', { unit: '{connection}' });
const poolMax = meter.createObservableUpDownCounter('db.client.connection.max', { unit: '{connection}' });
const poolPending = meter.createObservableUpDownCounter('db.client.connection.pending_requests', { unit: '{request}' });
meter.addBatchObservableCallback((r) => {
  const a = { 'db.client.connection.pool.name': 'demo' };
  r.observe(poolCount, pool.idle, { ...a, 'db.client.connection.state': 'idle' });
  r.observe(poolCount, pool.total - pool.idle, { ...a, 'db.client.connection.state': 'used' });
  r.observe(poolMax, pool.total, a);
  r.observe(poolPending, pool.waiting, a);
}, [poolCount, poolMax, poolPending]);
const waitTime = meter.createHistogram('db.client.connection.wait_time', { unit: 's' });
const timeouts = meter.createCounter('db.client.connection.timeouts', { unit: '{timeout}' });

// Tiny HTTP server so instrumentation-http emits its server duration metric.
const server = http.createServer((req, res) => {
  const ms = req.url === '/slow' ? 300 : 5;
  setTimeout(() => { res.statusCode = req.url === '/fail' ? 500 : 200; res.end('ok'); }, ms);
}).listen(18080);

let tick = 0;
const timer = setInterval(() => {
  tick++;
  pool.idle = Math.max(0, 7 - tick); pool.waiting = Math.max(0, tick - 7);
  waitTime.record(0.002 * tick, { 'db.client.connection.pool.name': 'demo' });
  for (const p of ['/ok', '/slow', '/fail']) http.get(`http://localhost:18080${p}`, (r) => r.resume());
  log.info({ route: '/orders', status: 200, duration_ms: 12 }, 'request completed');
  if (pool.waiting > 0) {
    timeouts.add(1, { 'db.client.connection.pool.name': 'demo' });
    log.error({ err: { message: 'timeout exceeded when trying to connect' }, route: '/orders' }, 'request failed');
  }
}, 1000);

const stop = async () => { clearInterval(timer); server.close(); await globalThis.__otelShutdown(); process.exit(0); };
setTimeout(stop, Number(process.env.RUN_SECONDS ?? 40) * 1000);
process.on('SIGINT', stop);
