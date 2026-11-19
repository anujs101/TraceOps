/**
 * TraceOps process entry point (Wave 2): migrate → detector loop → worker loop → read API on :4000.
 *   npm run start:env -w @traceops/app     # env from the repo-root .env (tsx --env-file)
 *   npm start -w @traceops/app             # env from the shell only
 *
 * Env (environment.md §4): TRACEOPS_DATABASE_URL, PROMETHEUS_URL, LOKI_URL, LLM_PROVIDER and the
 * provider's variables, optional TRACEOPS_REOPEN_WINDOW_S (evaluation only). This process never
 * reads .env itself and never prints env values.
 */
import type { Server } from 'node:http';
import { createPool } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import { PgInvestigationStore } from '../db/store.ts';
import { Detector } from '../detector/detector.ts';
import { Worker } from '../queue/worker.ts';
import { createTools } from '../tools/index.ts';
import { createLlmProvider } from '../llm/index.ts';
import { investigate } from '../investigator/investigate.ts';
import { startApi } from '../api/server.ts';
import { loadAppConfig, redactDbUrl } from './config.ts';
import { makeJobHandler } from './handler.ts';

const log = (scope: string) => (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) =>
  console[level === 'info' ? 'log' : level](`${new Date().toISOString()} [${scope}] ${msg}${fields ? ' ' + JSON.stringify(fields) : ''}`);
const app = log('app');

const cfg = loadAppConfig(process.env);
// Fail at startup, not on the first job, if the provider can't be built (missing key, unimplemented).
createLlmProvider({ record: () => undefined }, process.env);

const pool = createPool(cfg.databaseUrl);
const applied = await migrate(pool);
app('info', 'database ready', { url: redactDbUrl(cfg.databaseUrl), migrations_applied: applied });
app('info', 'config', {
  prometheus: cfg.prometheusUrl, loki: cfg.lokiUrl, provider: cfg.provider,
  reopen_window_s: cfg.rules.evaluation.reopen_window_s, reopen_override: cfg.reopenWindowOverride !== null,
});
if (cfg.reopenWindowOverride !== null) app('warn', `reopen_window_s=${cfg.reopenWindowOverride} (override; contract value is used when TRACEOPS_REOPEN_WINDOW_S is unset)`);

const store = new PgInvestigationStore(pool);
const detector = new Detector({ config: cfg.rules, pool, prometheusUrl: cfg.prometheusUrl, log: log('detector') });
const worker = new Worker({
  pool,
  log: log('worker'),
  handler: makeJobHandler({
    store, investigate, createTools,
    makeProvider: (recorder) => createLlmProvider(recorder, process.env),
    prometheusUrl: cfg.prometheusUrl, lokiUrl: cfg.lokiUrl,
    log: log('handler'),
  }),
});

let api: Server | null = null;
await detector.start();
worker.start();
api = await startApi(store, { port: cfg.apiPort, log: (l) => app('warn', l) });
app('info', `TraceOps API on http://127.0.0.1:${cfg.apiPort}/api/health`);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  app('info', `${signal}: shutting down`);
  await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  await Promise.allSettled([worker.stop(), detector.stop()]);
  await pool.end();
  app('info', 'stopped');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
