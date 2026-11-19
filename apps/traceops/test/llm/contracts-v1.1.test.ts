import Groq from 'groq-sdk';
import { describe, expect, it } from 'vitest';
import { LlmCall, LLM_ERROR_KINDS, RETRYABLE_LLM_ERRORS } from '@traceops/contracts';
import { createLlmProvider, selectedProvider, MemoryRecorder, RecordingProvider, toLlmCallRow, withRetry, LlmError } from '../../src/llm/index.ts';
import { loadGroqConfig } from '../../src/llm/groq/config.ts';
import { createGroqClient, GroqProvider } from '../../src/llm/groq/adapter.ts';
import { runToolLoop } from '../../src/llm/tool-loop.ts';
import { generateValidatedReport } from '../../src/report/generate.ts';
import { FakeGroqClient, textResponse, toolResponse } from './fakes.ts';
import { evidence, repairedReport, firstLiveReport } from '../fixtures/first-live-report.ts';

const KEY = { GROQ_API_KEY: 'gsk_TESTKEYtestkeyTESTKEYtestkeyTESTKEYtestkey12345678' };
const INV = '22222222-2222-4222-8222-222222222222';

describe('provider selection (LLM_PROVIDER)', () => {
  it('defaults to groq and builds a recorded provider without network', () => {
    expect(selectedProvider({})).toBe('groq');
    const p = createLlmProvider(new MemoryRecorder(), KEY);
    expect(p).toBeInstanceOf(RecordingProvider);
    expect([p.name, p.model]).toEqual(['groq', 'openai/gpt-oss-20b']);
  });
  it('rejects unknown providers at startup', () => {
    expect(() => selectedProvider({ LLM_PROVIDER: 'openai' })).toThrow(/unsupported LLM_PROVIDER "openai"/);
  });
  it('v1.2: accepts deepseek; building it fails clearly until session E adds the adapter', () => {
    expect(selectedProvider({ LLM_PROVIDER: 'deepseek' })).toBe('deepseek');
    expect(() => createLlmProvider(new MemoryRecorder(), { LLM_PROVIDER: 'deepseek' })).toThrow(/not implemented yet/);
  });
});

describe('Groq configuration', () => {
  it('defaults base URL to the API host and passes it to the SDK explicitly', () => {
    const c = loadGroqConfig(KEY);
    expect(c.baseUrl).toBe('https://api.groq.com');
    expect((createGroqClient(c) as unknown as Groq).baseURL).toBe('https://api.groq.com');
  });
  it('accepts an override and strips trailing slashes', () => {
    expect(loadGroqConfig({ ...KEY, GROQ_BASE_URL: 'https://proxy.example.com/' }).baseUrl).toBe('https://proxy.example.com');
  });
  it.each([
    ['OpenAI-style path the SDK would double', { GROQ_BASE_URL: 'https://api.groq.com/openai/v1' }, /SDK adds \/openai\/v1/],
    ['plain http to a remote host', { GROQ_BASE_URL: 'http://api.groq.com' }, /https/],
    ['not a URL', { GROQ_BASE_URL: 'groq' }, /valid URL/],
    ['bad timeout', { GROQ_TIMEOUT_MS: '0' }, /GROQ_TIMEOUT_MS/],
    ['bad reasoning effort', { GROQ_REASONING_EFFORT: 'max' }, /GROQ_REASONING_EFFORT/],
  ])('rejects %s', (_n, env, msg) => expect(() => loadGroqConfig({ ...KEY, ...env })).toThrow(msg));
  it('allows http only for localhost (tests/proxies)', () => {
    expect(loadGroqConfig({ ...KEY, GROQ_BASE_URL: 'http://localhost:8787' }).baseUrl).toBe('http://localhost:8787');
  });
});

describe('error taxonomy comes from the contract', () => {
  it.each(LLM_ERROR_KINDS)('%s retryability matches RETRYABLE_LLM_ERRORS', (k) => {
    expect(new LlmError(k, 'x').retryable).toBe(RETRYABLE_LLM_ERRORS.includes(k));
  });
});

describe('llm_calls rows (Contracts v1.1)', () => {
  const groq = (q: unknown[]) => {
    const rec = new MemoryRecorder();
    return { rec, p: new RecordingProvider(new GroqProvider(new FakeGroqClient(q), { model: 'openai/gpt-oss-20b', reasoningEffort: null }), rec) };
  };

  it('successful, failed and usage-less calls all map to valid rows', async () => {
    const noUsage = { ...textResponse('ok'), usage: undefined };
    const rl = () => { throw Groq.APIError.generate(429, { error: { message: 'rl' } }, undefined, new Headers({ 'retry-after': '1' })); };
    const { rec, p } = groq([textResponse('a'), rl, noUsage]);
    const trace = { investigationId: INV, turn: 1 };
    await p.chat({ stage: 'investigate', trace, messages: [], tools: [], maxOutputTokens: 8 });
    await p.chat({ stage: 'investigate', trace: { ...trace, turn: 2 }, messages: [], tools: [], maxOutputTokens: 8 }).catch(() => {});
    await p.chat({ stage: 'investigate', trace: { ...trace, turn: 3 }, messages: [], tools: [], maxOutputTokens: 8 });
    const rows = rec.records.map((r) => toLlmCallRow(r));
    for (const r of rows) expect(LlmCall.safeParse(r).success).toBe(true);
    expect(rows.map((r) => [r.turn, r.attempt, r.status, r.error_kind, r.input_tokens])).toEqual([
      [1, 1, 'ok', null, 100], [2, 1, 'error', 'rate_limit', null], [3, 1, 'ok', null, null],
    ]);
    expect(rows[1]).toMatchObject({ error_status: 429, retry_after_ms: 1000, cache_read_tokens: null });
  });

  it('retries of one turn get increasing attempt numbers', async () => {
    const rl = () => { throw Groq.APIError.generate(429, { error: { message: 'rl' } }, undefined, new Headers({ 'retry-after': '0' })); };
    const { rec, p } = groq([rl, rl, textResponse('ok')]);
    await withRetry(() => p.chat({ stage: 'investigate', trace: { investigationId: INV, turn: 4 }, messages: [], tools: [], maxOutputTokens: 8 }), { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 10 }, async () => {});
    expect(rec.records.map((r) => [r.turn, r.attempt, r.status])).toEqual([[4, 1, 'error'], [4, 2, 'error'], [4, 3, 'ok']]);
  });

  it('records without an investigation trace are not persistable', async () => {
    const { rec, p } = groq([textResponse('a')]);
    await p.chat({ stage: 'smoke', messages: [], tools: [], maxOutputTokens: 8 });
    expect(() => toLlmCallRow(rec.records[0]!)).toThrow(/no investigation trace/);
  });

  it('turns are numbered across stages: investigate turns, then report rounds', async () => {
    const { rec, p } = groq([
      toolResponse([{ name: 'noop', arguments: '{}' }]), textResponse('done'), // investigate turns 1-2
      textResponse(JSON.stringify(firstLiveReport)), textResponse(JSON.stringify(repairedReport)), // report turns 3-4
    ]);
    const loop = await runToolLoop(p, [{ role: 'user', content: 'go' }], [], { stage: 'investigate', maxToolCalls: 2, maxTurns: 3, maxOutputTokens: 8, trace: { investigationId: INV } });
    await generateValidatedReport(p, [{ role: 'user', content: 'r' }], evidence, { investigationId: INV, firstTurn: loop.turns + 1, maxOutputTokens: 8, sink: { save: async () => {} } });
    const rows = rec.records.map((r) => toLlmCallRow(r));
    expect(rows.map((r) => [r.stage, r.kind, r.turn, r.attempt, r.stop_reason])).toEqual([
      ['investigate', 'chat', 1, 1, 'tool_calls'], ['investigate', 'chat', 2, 1, 'end'],
      ['report', 'structured', 3, 1, 'end'], ['report', 'structured', 4, 1, 'end'],
    ]);
  });
});
