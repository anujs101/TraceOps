import { describe, expect, it } from 'vitest';
import { applyReopenOverride, loadAppConfig, redactDbUrl } from '../../src/app/config.ts';
import { loadRuleConfig } from '../../src/detector/config.ts';
import { PgCallRecorder } from '../../src/app/pg-recorder.ts';
import type { LlmCallRecord } from '../../src/llm/index.ts';

const rules = loadRuleConfig();

describe('app config', () => {
  it('defaults follow environment.md §4 and the contract reopen window stays', () => {
    const c = loadAppConfig({}, rules);
    expect(c).toMatchObject({
      databaseUrl: 'postgres://traceops:traceops@localhost:5432/traceops',
      prometheusUrl: 'http://localhost:9090', lokiUrl: 'http://localhost:3100',
      provider: 'groq', apiPort: 4000, reopenWindowOverride: null,
    });
    expect(c.rules.evaluation.reopen_window_s).toBe(300);
  });

  it('TRACEOPS_REOPEN_WINDOW_S overrides reopen_window_s only', () => {
    const { rules: r, override } = applyReopenOverride(rules, '30');
    expect(override).toBe(30);
    expect(r.evaluation).toEqual({ ...rules.evaluation, reopen_window_s: 30 });
    expect(r.rules).toEqual(rules.rules);
    expect(applyReopenOverride(rules, '0').override).toBe(0);
    expect(applyReopenOverride(rules, '  ').override).toBeNull();
  });

  it.each(['-1', '1.5', 'abc', '30s'])('rejects TRACEOPS_REOPEN_WINDOW_S=%s', (v) => {
    expect(() => applyReopenOverride(rules, v)).toThrow(/non-negative integer/);
  });

  it('fails fast on an unknown LLM_PROVIDER and bad backend URLs; accepts deepseek (v1.2)', () => {
    expect(() => loadAppConfig({ LLM_PROVIDER: 'openai' }, rules)).toThrow(/unsupported LLM_PROVIDER/);
    expect(() => loadAppConfig({ PROMETHEUS_URL: 'ftp://x' }, rules)).toThrow(/PROMETHEUS_URL/);
    expect(() => loadAppConfig({ LOKI_URL: 'not a url' }, rules)).toThrow(/LOKI_URL/);
    expect(loadAppConfig({ LLM_PROVIDER: 'deepseek' }, rules).provider).toBe('deepseek');
  });

  it('never logs a database password', () => {
    expect(redactDbUrl('postgres://traceops:s3cret@db:5432/traceops')).toBe('postgres://traceops:***@db:5432/traceops');
    expect(redactDbUrl('nonsense')).not.toContain('nonsense');
  });
});

describe('PgCallRecorder', () => {
  const rec = (turn: number) => ({ investigationId: 'i', turn, attempt: 1 }) as unknown as LlmCallRecord;

  it('writes attempts in order and flush waits for all of them', async () => {
    const written: number[] = [];
    const r = new PgCallRecorder({ insertLlmCall: async (x) => { await new Promise((ok) => setTimeout(ok, 5 - (x.turn ?? 0))); written.push(x.turn!); } });
    r.record(rec(1)); r.record(rec(2)); r.record(rec(3));
    expect(await r.flush()).toEqual({ failures: 0 });
    expect(written).toEqual([1, 2, 3]);
  });

  it('a failed insert is logged redacted, counted, and does not stop later rows', async () => {
    const logs: unknown[] = [];
    const written: number[] = [];
    const r = new PgCallRecorder({
      insertLlmCall: async (x) => { if (x.turn === 1) throw new Error('db down key gsk_ABCDEFGHijklmnop12345678'); written.push(x.turn!); },
    }, (m, f) => logs.push({ m, f }));
    r.record(rec(1)); r.record(rec(2));
    expect(await r.flush()).toEqual({ failures: 1 });
    expect(written).toEqual([2]);
    expect(JSON.stringify(logs)).not.toContain('gsk_ABCDEFGH');
  });
});
