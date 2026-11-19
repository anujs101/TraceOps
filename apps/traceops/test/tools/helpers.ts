import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', 'packages', 'contracts', 'fixtures');

export type Scenario = 'S1' | 'S2';

/** Raw captured backend response (never hand-written). */
export function loadFixtureText(sc: Scenario, file: string): string {
  return readFileSync(join(ROOT, sc, file), 'utf8');
}
export const loadFixture = (sc: Scenario, file: string): unknown => JSON.parse(loadFixtureText(sc, file));
export const loadManifest = (sc: Scenario) =>
  loadFixture(sc, 'manifest.json') as { start: string; end: string; deploy_at: string; service: string; step_s: number };

export type Call = { url: URL; headers: Record<string, string>; signal: AbortSignal | null | undefined };

/**
 * A fetch that answers from a script of responses (fixture text, or an Error to reject with)
 * and records every call. The bodies are real captured fixtures; only the transport is replaced.
 */
export function replayFetch(script: (string | Error | { status: number; body: string })[]) {
  const calls: Call[] = [];
  const fn = (async (input: URL | string | Request, init?: RequestInit) => {
    const step = script[Math.min(calls.length, script.length - 1)]!;
    calls.push({ url: new URL(input instanceof Request ? input.url : String(input)), headers: (init?.headers ?? {}) as Record<string, string>, signal: init?.signal });
    if (step instanceof Error) throw step;
    const { status, body } = typeof step === 'string' ? { status: 200, body: step } : step;
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

// ── tool harness ────────────────────────────────────────────────────────────
import { Incident, deriveWindows, type Evidence } from '@traceops/contracts';
import { createToolsWith } from '../../src/tools/index.ts';
import type { ToolContext } from '../../src/seams.ts';

export const INVESTIGATION_ID = '3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

/** An incident whose windows line up with a scenario's captured fixtures: it starts at the fault, and the investigation starts when capture ended. */
export function scenarioIncident(sc: Scenario) {
  const m = loadManifest(sc);
  const incident = Incident.parse({
    id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', fingerprint: 'a'.repeat(64), service: m.service, group: 'latency',
    status: 'open', severity: 'critical', started_at: m.deploy_at, detected_at: m.deploy_at, resolved_at: null, reopen_count: 0,
    trigger: [{ rule_id: 'latency-p95', query: 'latency_p95', threshold: 1, observed: 2, at: m.deploy_at }],
  });
  const investigationStart = m.end;
  return { incident, investigationStart, windows: deriveWindows(incident.started_at, investigationStart), manifest: m };
}

export function harness(sc: Scenario, script: Parameters<typeof replayFetch>[0], over: Partial<ToolContext> = {}) {
  const { incident, investigationStart, windows } = scenarioIncident(sc);
  const rows: Evidence[] = [];
  const net = replayFetch(script);
  const ctx: ToolContext = {
    investigationId: INVESTIGATION_ID, incident, investigationStart,
    prometheusUrl: 'http://prom.test:9090', lokiUrl: 'http://loki.test:3100',
    evidence: { append: async (row) => { rows.push(row); } },
    budget: { maxToolCalls: 12, deadline: Date.now() + 180_000 },
    ...over,
  };
  const tools = createToolsWith({ fetch: net.fetch, timeoutMs: 200 })(ctx);
  const call = (name: string, args: unknown, signal?: AbortSignal) => {
    const t = tools.find((x) => x.spec.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.run(args, { signal }) as Promise<any>;
  };
  return { call, rows, calls: net.calls, tools, windows, ctx };
}
