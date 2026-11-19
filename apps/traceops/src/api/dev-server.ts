/**
 * DEV ONLY: the read API on port 4000 over an in-memory store seeded from the
 * S1 fixtures (no Postgres, no Groq, no network calls).
 *   npx tsx apps/traceops/src/api/dev-server.ts
 */
import { PORTS } from '@traceops/contracts';
import { MemoryStore } from './memory-store.ts';
import { seedS1 } from './dev/seed-s1.ts';
import { startApi } from './server.ts';

const store = new MemoryStore();
await seedS1(store);
const port = PORTS.traceopsApi;
await startApi(store, { port, log: (l) => console.error(l) });
console.log(`TraceOps dev API (fixture store) on http://127.0.0.1:${port}/api/incidents`);
