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
