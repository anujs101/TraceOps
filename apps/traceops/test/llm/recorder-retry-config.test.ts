import Groq from 'groq-sdk';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadGroqConfig, DEFAULT_GROQ_MODEL } from '../../src/llm/groq/config.ts';
import { GroqProvider } from '../../src/llm/groq/adapter.ts';
import { MemoryRecorder, RecordingProvider } from '../../src/llm/recorder.ts';
import { withRetry } from '../../src/llm/retry.ts';
import { LlmError } from '../../src/llm/errors.ts';
import { FakeGroqClient, textResponse } from './fakes.ts';

const KEY = 'gsk_TESTKEYtestkeyTESTKEYtestkeyTESTKEYtestkey12345678';
const req = { stage: 'investigate', messages: [{ role: 'user' as const, content: 'x' }], tools: [], maxOutputTokens: 8 };

describe('config', () => {
  it('defaults the model and never reveals the key via string/JSON/inspect', () => {
    const c = loadGroqConfig({ GROQ_API_KEY: KEY });
    expect(c.model).toBe(DEFAULT_GROQ_MODEL);
    expect(DEFAULT_GROQ_MODEL).toBe('openai/gpt-oss-20b');
    for (const s of [String(c.apiKey), JSON.stringify(c), inspect(c)]) expect(s).not.toContain(KEY);
    expect(c.apiKey.reveal()).toBe(KEY);
  });
  it('honours GROQ_MODEL and fails clearly without a key', () => {
    expect(loadGroqConfig({ GROQ_API_KEY: KEY, GROQ_MODEL: 'openai/gpt-oss-120b' }).model).toBe('openai/gpt-oss-120b');
    expect(() => loadGroqConfig({})).toThrow('GROQ_API_KEY is not set');
  });
});

describe('call recording', () => {
  it('records model, tokens, latency, request id and stop reason for successful calls', async () => {
    const rec = new MemoryRecorder();
    let t = 0;
    const p = new RecordingProvider(new GroqProvider(new FakeGroqClient([textResponse('ok')]), { model: 'openai/gpt-oss-20b', reasoningEffort: null }), rec, () => (t += 250));
    await p.chat(req);
    expect(rec.records[0]).toMatchObject({ provider: 'groq', model: 'openai/gpt-oss-20b', stage: 'investigate', kind: 'chat', status: 'ok', latencyMs: 250,
      requestId: 'req_test', inputTokens: 100, outputTokens: 20, totalTokens: 120, stopReason: 'end', toolCallCount: 0, errorKind: null });
  });

  it('records errors (kind, status, retry-after) and never the key', async () => {
    const rec = new MemoryRecorder();
    const thrower = () => { throw Groq.APIError.generate(429, { error: { message: `rate limited for ${KEY}` } }, undefined, new Headers({ 'retry-after': '3' })); };
    const p = new RecordingProvider(new GroqProvider(new FakeGroqClient([thrower]), { model: 'm', reasoningEffort: null }), rec);
    await expect(p.chat(req)).rejects.toBeInstanceOf(LlmError);
    expect(rec.records[0]).toMatchObject({ status: 'error', errorKind: 'rate_limit', errorStatus: 429, retryAfterMs: 3000, inputTokens: null });
    expect(JSON.stringify(rec.records)).not.toContain(KEY);
  });
});

describe('retry policy', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };

  it('retries rate limits honouring retry-after, each attempt recorded', async () => {
    sleeps.length = 0;
    const rec = new MemoryRecorder();
    const rl = () => { throw Groq.APIError.generate(429, { error: { message: 'rl' } }, undefined, new Headers({ 'retry-after': '2' })); };
    const p = new RecordingProvider(new GroqProvider(new FakeGroqClient([rl, textResponse('ok')]), { model: 'm', reasoningEffort: null }), rec);
    const r = await withRetry(() => p.chat(req), { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 }, sleep);
    expect(r.content).toBe('ok');
    expect(sleeps).toEqual([2000]);
    expect(rec.records.map((x) => x.status)).toEqual(['error', 'ok']);
  });

  it('does not retry auth or bad_request', async () => {
    for (const kind of ['auth', 'bad_request', 'schema_violation', 'malformed_response'] as const) {
      let n = 0;
      await expect(withRetry(async () => { n++; throw new LlmError(kind, 'x'); }, undefined, sleep)).rejects.toMatchObject({ kind });
      expect(n).toBe(1);
    }
  });

  it('gives up after maxAttempts with exponential backoff', async () => {
    sleeps.length = 0;
    let n = 0;
    await expect(withRetry(async () => { n++; throw new LlmError('server', 'x'); }, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 }, sleep)).rejects.toMatchObject({ kind: 'server' });
    expect(n).toBe(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it('surfaces a retry-after longer than the budget instead of waiting', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new LlmError('rate_limit', 'x', { retryAfterMs: 60_000 }); }, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 20_000 }, sleep)).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(n).toBe(1);
  });
});
