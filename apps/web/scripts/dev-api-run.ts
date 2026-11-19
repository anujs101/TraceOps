/**
 * DEV ONLY: the TraceOps read API over an in-memory store holding the S1
 * fixture investigations (seedS1) plus every recorded live run in docs/runs/.
 * Port 4100 by default, never 4000: the real app owns 4000 during live runs.
 *   npm run dev:api:run -w @traceops/web        (then: VITE_API_TARGET=http://localhost:4100 npm run dev -w @traceops/web)
 */
import { MemoryStore } from '../../traceops/src/api/memory-store.ts';
import { seedS1 } from '../../traceops/src/api/dev/seed-s1.ts';
import { startApi } from '../../traceops/src/api/server.ts';
import { loadRun, runDirs } from './load-run.ts';

const port = Number(process.env.DEV_API_PORT ?? 4100);
if (port === 4000) throw new Error('dev-api-run must not use port 4000 (the real TraceOps API)');

const store = new MemoryStore();
await seedS1(store);
for (const dir of runDirs()) {
  const { investigationId } = loadRun(store, dir);
  console.log(`loaded ${dir.split('/').pop()} → #/investigations/${investigationId}`);
}
await startApi(store, { port, log: (l) => console.error(l) });
console.log(`TraceOps dev API (fixtures + recorded runs) on http://127.0.0.1:${port}/api/incidents`);
