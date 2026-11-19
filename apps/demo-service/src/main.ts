import pino from 'pino';
import { createApp } from './app';
import { loadConfig } from './config';
import { createPool, initSchema } from './db';
import { registerPoolMetrics } from './metrics';

async function main() {
  const config = loadConfig();
  const log = pino({ level: 'info' });
  const pool = createPool(config.databaseUrl);
  const acquire = registerPoolMetrics(pool);
  await initSchema(pool);
  const app = createApp({ acquire, log, fault: config.fault, cpuIter: config.cpuIter });
  const server = app.listen(config.port, () => log.info({}, 'service started'));
  const stop = async () => {
    server.close();
    await (globalThis as { __otelShutdown?: () => Promise<void> }).__otelShutdown?.();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
