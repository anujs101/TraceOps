import { describe, expect, it } from 'vitest';
import { LlmError } from '../../src/llm/index.ts';
import { describeError, makeInvestigate, redactAccountIds } from '../../src/investigator/investigate.ts';
import { pacingFor, PROVIDER_PACING, TokenPacer, PacedProvider } from '../../src/investigator/pacing.ts';
import type { ChatRequest, ChatResult, LlmProvider, StructuredResult } from '../../src/llm/index.ts';
import { fixtureCreateTools, INV_ID, INVESTIGATION_START, memorySinks, S1_INCIDENT } from './fakes.ts';

/** Fake clock: sleep advances time. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, advance: (ms: number) => { t += ms; }, sleeps };
}

/** Provider with a configurable name and fixed reported usage per call. */
class UsageProvider implements LlmProvider {
  readonly model = 'm';
  calls: Array<{ at: number; kind: string }> = [];
  constructor(readonly name: string, private readonly clk: { now: () => number }, private readonly usage: number | null, private readonly script: Array<'tool' | 'end' | 'report'>, private readonly report: unknown = {}) {}
  private meta() { return { provider: this.name, model: this.model, requestId: null, usage: this.usage === null ? null : { inputTokens: this.usage, outputTokens: 0, totalTokens: this.usage }, providerTimings: null }; }
  async chat(_req: ChatRequest): Promise<ChatResult> {
    this.calls.push({ at: this.clk.now(), kind: 'chat' });
    const step = this.script.shift();
    if (step === 'tool') return { content: null, toolCalls: [{ id: `c${this.calls.length}`, name: 'log_volume', argumentsJson: '{"window":"incident"}' }], stopReason: 'tool_calls', meta: this.meta() };
    return { content: 'done', toolCalls: [], stopReason: 'end', meta: this.meta() };
  }
  async structured(): Promise<StructuredResult> {
    this.calls.push({ at: this.clk.now(), kind: 'structured' });
    return { value: this.report, rawText: '{}', meta: this.meta() };
  }
}

describe('pacing config', () => {
  it('is keyed by provider name: groq on, deepseek off, unknown off', () => {
    expect(pacingFor('groq')).toEqual({ tokensPerMinute: 7500 });
    expect(pacingFor('deepseek')).toBeNull();
    expect('deepseek' in PROVIDER_PACING).toBe(true);
    expect(pacingFor('something-else')).toBeNull();
  });
});

describe('TokenPacer', () => {
  it('waits until the trailing-minute total plus the reservation fits', async () => {
    const c = clock();
    const p = new TokenPacer(1000, c.now, c.sleep);
    expect(await p.acquire(600)).toBe(0);
    p.record(600);
    c.advance(10_000);
    const waited = await p.acquire(600); // 600 + 600 > 1000 → wait for the first to leave the window
    expect(waited).toBe(50_001);
    expect(p.windowTokens()).toBe(0);
  });

  it('frees only as much of the window as needed', async () => {
    const c = clock();
    const p = new TokenPacer(1000, c.now, c.sleep);
    p.record(300); c.advance(5_000); p.record(300); c.advance(5_000); p.record(300);
    await p.acquire(400); // needs 300 freed: only the oldest entry
    expect(c.sleeps).toEqual([50_001]);
    expect(p.windowTokens()).toBe(600);
  });

  it('a request larger than the whole budget goes once the window is empty', async () => {
    const c = clock();
    const p = new TokenPacer(1000, c.now, c.sleep);
    expect(await p.acquire(5000)).toBe(0); // empty window
    p.record(5000);
    expect(await p.acquire(5000)).toBe(60_001);
  });

  it('PacedProvider records reported usage, or the reservation when usage is missing', async () => {
    const c = clock();
    const pacer = new TokenPacer(10_000, c.now, c.sleep);
    const req: ChatRequest = { stage: 'investigate', messages: [{ role: 'user', content: 'x'.repeat(400) }], tools: [], maxOutputTokens: 100 };
    await new PacedProvider(new UsageProvider('groq', c, 42, ['end']), pacer).chat(req);
    expect(pacer.windowTokens()).toBe(42);
    await new PacedProvider(new UsageProvider('groq', c, null, ['end']), pacer).chat(req);
    expect(pacer.windowTokens()).toBe(42 + 101 + 100); // ceil((400 chars + "[]") / 4) + output cap
  });

  it('a rejected request consumes nothing', async () => {
    const c = clock();
    const pacer = new TokenPacer(10_000, c.now, c.sleep);
    const failing: LlmProvider = { name: 'groq', model: 'm', chat: async () => { throw new LlmError('rate_limit', '429', { status: 429 }); }, structured: async () => { throw new Error('unused'); } };
    await expect(new PacedProvider(failing, pacer).chat({ stage: 'investigate', messages: [], tools: [], maxOutputTokens: 10 })).rejects.toThrow();
    expect(pacer.windowTokens()).toBe(0);
  });
});

describe('investigate() pacing', () => {
  const input = (provider: LlmProvider, isCancelled = async () => false) => {
    const sinks = memorySinks();
    return {
      sinks,
      input: {
        investigationId: INV_ID, incident: S1_INCIDENT, investigationStart: INVESTIGATION_START, provider, createTools: fixtureCreateTools().create,
        evidence: sinks.evidenceSink, reports: sinks.reportSink, isCancelled, prometheusUrl: '', lokiUrl: '',
      },
    };
  };

  it('groq (by name) is paced from config: requests are spread to fit the budget', async () => {
    const c = clock();
    const prov = new UsageProvider('groq', c, 5000, ['tool', 'end']);
    const waits: number[] = [];
    const { input: i } = input(prov);
    await makeInvestigate({ now: c.now, sleep: c.sleep, onPace: (e) => waits.push(e.waitedMs), chatMaxOutputTokens: 1024, reportMaxOutputTokens: () => 1500 })(i);
    expect(prov.calls).toHaveLength(4); // tool turn, end turn, report, repair
    for (let k = 1; k < prov.calls.length; k++) expect(prov.calls[k]!.at - prov.calls[k - 1]!.at).toBeGreaterThanOrEqual(60_000); // 5000 used + next reservation > 7500
    expect(waits.length).toBe(3);
  });

  it('deepseek (by name) is not paced by default', async () => {
    const c = clock();
    const prov = new UsageProvider('deepseek', c, 5000, ['tool', 'end']);
    const { input: i } = input(prov);
    await makeInvestigate({ now: c.now, sleep: c.sleep })(i);
    expect(c.sleeps).toEqual([]);
    expect(new Set(prov.calls.map((x) => x.at)).size).toBe(1);
  });

  it('an explicit config overrides the table; null disables it', async () => {
    const c = clock();
    const prov = new UsageProvider('deepseek', c, 5000, ['tool', 'end']);
    const { input: i } = input(prov);
    await makeInvestigate({ now: c.now, sleep: c.sleep, pacing: { tokensPerMinute: 6000 }, reportMaxOutputTokens: () => 500 })(i);
    expect(c.sleeps.length).toBeGreaterThan(0);
  });

  it('cancel is re-checked after a pacing wait', async () => {
    const c = clock();
    const prov = new UsageProvider('groq', c, 7000, ['tool', 'end']);
    let checks = 0;
    const { input: i, sinks } = input(prov, async () => ++checks > 3); // turn 1, tool 1, turn 2 (before wait) pass; after the wait: cancelled
    const out = await makeInvestigate({ now: c.now, sleep: c.sleep })(i);
    expect(out.status).toBe('cancelled');
    expect(prov.calls).toHaveLength(1);
    expect(sinks.reports).toHaveLength(0);
  });
});

describe('error redaction', () => {
  it('redacts provider organization ids and keys from the stored error', () => {
    const e = new LlmError('rate_limit', 'Rate limit reached for model `m` in organization `org_01kq9bxsbge8xrp5bqd442snye` service tier on_demand; key gsk_abcdefghijklmnop', { status: 429 });
    const s = describeError(e);
    expect(s).not.toMatch(/org_01kq/);
    expect(s).toContain('org_[REDACTED]');
    expect(s).not.toContain('gsk_abcdefghijklmnop');
    expect(redactAccountIds('organization org_ABC123 and borg_x')).toBe('organization org_[REDACTED] and borg_x');
  });
});
