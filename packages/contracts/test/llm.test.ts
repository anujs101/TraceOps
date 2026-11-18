import { describe, expect, it } from 'vitest';
import { LlmCall, LLM_DEFAULTS, LLM_ERROR_KINDS, RETRYABLE_LLM_ERRORS } from '../src/index.ts';

const ok = {
  id: '11111111-1111-4111-8111-111111111111', investigation_id: '22222222-2222-4222-8222-222222222222',
  turn: 1, attempt: 1, provider: 'groq', model: 'openai/gpt-oss-20b', stage: 'investigate', kind: 'chat', status: 'ok',
  request_id: 'req_01', input_tokens: 228, output_tokens: 116, cache_read_tokens: null, latency_ms: 573,
  stop_reason: 'tool_calls', tool_call_count: 1, error_kind: null, error_status: null, error_message: null,
  retry_after_ms: null, provider_timings: { queue_ms: 289, total_ms: 140 }, created_at: '2026-11-16T18:54:39.671Z',
};
const err = { ...ok, attempt: 2, status: 'error', request_id: null, input_tokens: null, output_tokens: null, latency_ms: 23,
  stop_reason: null, tool_call_count: null, error_kind: 'rate_limit', error_status: 429, error_message: 'Rate limit reached', retry_after_ms: 6000, provider_timings: null };

describe('llm_calls row (v1.1)', () => {
  it('accepts a successful call (real values from a live Groq call)', () => expect(LlmCall.safeParse(ok).success).toBe(true));
  it('accepts a failed call with no token usage', () => expect(LlmCall.safeParse(err).success).toBe(true));
  it('accepts a successful call whose provider reported no usage (NULL, not 0)', () =>
    expect(LlmCall.safeParse({ ...ok, input_tokens: null, output_tokens: null }).success).toBe(true));
  it('accepts a structured report call', () =>
    expect(LlmCall.safeParse({ ...ok, stage: 'report', kind: 'structured', stop_reason: 'end', tool_call_count: null }).success).toBe(true));

  it.each([
    ['ok row with an error kind', { ...ok, error_kind: 'server' }],
    ['ok row without stop reason', { ...ok, stop_reason: null }],
    ['error row without error kind', { ...err, error_kind: null }],
    ['error row with token usage', { ...err, input_tokens: 10 }],
    ['structured call with tool calls', { ...ok, kind: 'structured', tool_call_count: 1 }],
    ['unknown provider', { ...ok, provider: 'deepseek' }],
    ['unknown error kind', { ...err, error_kind: 'oops' }],
    ['turn 0', { ...ok, turn: 0 }],
    ['negative tokens', { ...ok, input_tokens: -1 }],
    ['non-IsoUtcMs created_at', { ...ok, created_at: '2026-11-16T18:54:39Z' }],
    ['extra field (e.g. a prompt)', { ...ok, prompt: 'secret context' }],
    ['over-long error message', { ...err, error_message: 'x'.repeat(301) }],
  ])('rejects %s', (_n, row) => expect(LlmCall.safeParse(row).success).toBe(false));
});

describe('LLM defaults and taxonomy', () => {
  it('Groq defaults: verified model id; base URL without the /openai/v1 path the SDK adds', () => {
    expect(LLM_DEFAULTS.groq.model).toBe('openai/gpt-oss-20b');
    expect(LLM_DEFAULTS.groq.baseUrl).toBe('https://api.groq.com');
  });
  it('retryable kinds are a subset of the taxonomy and exclude non-transient ones', () => {
    for (const k of RETRYABLE_LLM_ERRORS) expect(LLM_ERROR_KINDS).toContain(k);
    for (const k of ['auth', 'bad_request', 'schema_violation', 'malformed_response', 'truncated'] as const) expect(RETRYABLE_LLM_ERRORS).not.toContain(k);
  });
});
