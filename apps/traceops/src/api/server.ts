/**
 * Read API over InvestigationStore (spec D §5.3). node:http, no framework.
 *
 *   GET  /api/health
 *   GET  /api/incidents
 *   GET  /api/incidents/:id
 *   GET  /api/incidents/:id/investigations
 *   POST /api/incidents/:id/rerun              → 202 { job_id }
 *   GET  /api/investigations/:id
 *   GET  /api/investigations/:id/evidence
 *   GET  /api/investigations/:id/report        → 404 until a report exists
 *   GET  /api/investigations/:id/llm-calls
 *   POST /api/investigations/:id/cancel        → 202; 409 unless running
 *
 * Responses are JSON. Errors are { error: <code> }; internal details are never sent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PORTS } from '@traceops/contracts';
import type { InvestigationStore } from '../seams.ts';

type Handler = (store: InvestigationStore, id: string) => Promise<Reply>;
type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const notFound: Reply = { status: 404, body: { error: 'not_found' } };
const orNotFound = (v: unknown): Reply => (v == null ? notFound : ok(v));

const ROUTES: Array<{ method: 'GET' | 'POST'; pattern: RegExp; handler: Handler }> = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: async () => ok({ status: 'ok' }) },
  { method: 'GET', pattern: /^\/api\/incidents$/, handler: async (s) => ok(await s.listIncidents()) },
  { method: 'GET', pattern: /^\/api\/incidents\/([^/]+)$/, handler: async (s, id) => orNotFound(await s.getIncident(id)) },
  {
    method: 'GET', pattern: /^\/api\/incidents\/([^/]+)\/investigations$/,
    handler: async (s, id) => ((await s.getIncident(id)) ? ok(await s.listInvestigations(id)) : notFound),
  },
  {
    method: 'POST', pattern: /^\/api\/incidents\/([^/]+)\/rerun$/,
    handler: async (s, id) => ((await s.getIncident(id)) ? { status: 202, body: { job_id: await s.enqueueManual(id) } } : notFound),
  },
  { method: 'GET', pattern: /^\/api\/investigations\/([^/]+)$/, handler: async (s, id) => orNotFound(await s.getInvestigation(id)) },
  {
    method: 'GET', pattern: /^\/api\/investigations\/([^/]+)\/evidence$/,
    handler: async (s, id) => ((await s.getInvestigation(id)) ? ok(await s.listEvidence(id)) : notFound),
  },
  { method: 'GET', pattern: /^\/api\/investigations\/([^/]+)\/report$/, handler: async (s, id) => orNotFound(await s.getReport(id)) },
  {
    method: 'GET', pattern: /^\/api\/investigations\/([^/]+)\/llm-calls$/,
    handler: async (s, id) => ((await s.getInvestigation(id)) ? ok(await s.listLlmCalls(id)) : notFound),
  },
  {
    method: 'POST', pattern: /^\/api\/investigations\/([^/]+)\/cancel$/,
    handler: async (s, id) => {
      const inv = await s.getInvestigation(id);
      if (!inv) return notFound;
      if (inv.status !== 'running') return { status: 409, body: { error: 'not_running', status: inv.status } };
      await s.requestCancel(id);
      return { status: 202, body: { cancel_requested: true } };
    },
  },
];

export type ApiOptions = { allowedOrigins?: string[]; log?: (line: string) => void };

export function createApiHandler(store: InvestigationStore, opts: ApiOptions = {}) {
  const origins = new Set(opts.allowedOrigins ?? [`http://localhost:${PORTS.traceopsUi}`, `http://127.0.0.1:${PORTS.traceopsUi}`]);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const matches = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).filter((x) => x.m);
    let reply: Reply;
    if (matches.length === 0) reply = notFound;
    else {
      const hit = matches.find((x) => x.r.method === req.method);
      if (!hit) reply = { status: 405, body: { error: 'method_not_allowed' } };
      else {
        try {
          reply = await hit.r.handler(store, decodeURIComponent(hit.m![1] ?? ''));
        } catch (e) {
          opts.log?.(`api error ${req.method} ${path}: ${e instanceof Error ? e.name : 'error'}`);
          reply = { status: 500, body: { error: 'internal' } };
        }
      }
    }
    // drain any request body (POSTs take none)
    req.resume();
    res.writeHead(reply.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(reply.body));
  };
}

export function createApiServer(store: InvestigationStore, opts: ApiOptions = {}): Server {
  const handler = createApiHandler(store, opts);
  return createServer((req, res) => { void handler(req, res); });
}

export function startApi(store: InvestigationStore, opts: ApiOptions & { port?: number; host?: string } = {}): Promise<Server> {
  const server = createApiServer(store, opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? PORTS.traceopsApi, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}
