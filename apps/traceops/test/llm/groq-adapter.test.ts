import Groq from 'groq-sdk';
import { describe, expect, it } from 'vitest';
import { GroqProvider, mapGroqError, parseRetryAfter } from '../../src/llm/groq/adapter.ts';
import { LlmError } from '../../src/llm/errors.ts';
import { FakeGroqClient, textResponse, toolResponse, usage } from './fakes.ts';

const cfg = { model: 'openai/gpt-oss-20b', reasoningEffort: null };
const chatReq = { stage: 't', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxOutputTokens: 64 };
const sdkError = (status: number, body: object, headers: Record<string, string> = {}) =>
  Groq.APIError.generate(status, body, undefined, new Headers(headers));

describe('response parsing', () => {
  it('maps text content, stop reason, usage, timings and request id', async () => {
    const p = new GroqProvider(new FakeGroqClient([textResponse('hello')]), cfg);
    const r = await p.chat(chatReq);
    expect(r).toMatchObject({ content: 'hello', toolCalls: [], stopReason: 'end' });
    expect(r.meta).toEqual({ provider: 'groq', model: 'openai/gpt-oss-20b', requestId: 'req_test',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, providerTimings: { queue_ms: 100, prompt_ms: 10, completion_ms: 50, total_ms: 60 } });
  });

  it('parses tool calls and keeps raw argument strings for the tool loop', async () => {
    const p = new GroqProvider(new FakeGroqClient([toolResponse([{ id: 'fc_1', name: 'convert_duration', arguments: '{"value":1}' }])]), cfg);
    const r = await p.chat(chatReq);
    expect(r.stopReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([{ id: 'fc_1', name: 'convert_duration', argumentsJson: '{"value":1}' }]);
  });

  it('serialises tools and tool results into Groq request shape', async () => {
    const client = new FakeGroqClient([textResponse('ok')]);
    await new GroqProvider(client, cfg).chat({
      stage: 't', maxOutputTokens: 64,
      tools: [{ name: 'x', description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ id: 'fc_1', name: 'x', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: 'fc_1', name: 'x', content: '<tool_data>1</tool_data>' },
      ],
    });
    const body = client.bodies[0]!;
    expect(body.tool_choice).toBe('auto');
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }]);
    expect(body.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'fc_1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'fc_1', name: 'x', content: '<tool_data>1</tool_data>' },
    ]);
    expect(body).not.toHaveProperty('response_format'); // never combined with tools
  });

  it('structured(): sends strict json_schema without tools and parses JSON', async () => {
    const client = new FakeGroqClient([textResponse('{"a":1}')]);
    const r = await new GroqProvider(client, cfg).structured({ stage: 'report', messages: [{ role: 'user', content: 'x' }], schemaName: 'r', schema: { type: 'object' }, maxOutputTokens: 64 });
    expect(r.value).toEqual({ a: 1 });
    expect(client.bodies[0]!.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'r', schema: { type: 'object' }, strict: true } });
    expect(client.bodies[0]).not.toHaveProperty('tools');
  });
});

describe('malformed responses', () => {
  it.each([
    ['no choices', { usage }],
    ['empty choices', { choices: [] }],
    ['null message', { choices: [{ message: null }] }],
    ['tool_calls not array', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: 'x' } }] }],
    ['tool call without name', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'a', function: {} }] } }] }],
  ])('chat: %s → malformed_response', async (_n, res) => {
    await expect(new GroqProvider(new FakeGroqClient([res]), cfg).chat(chatReq)).rejects.toMatchObject({ kind: 'malformed_response' });
  });

  it.each([
    ['non-JSON content', textResponse('not json'), 'malformed_response'],
    ['empty content', textResponse(''), 'malformed_response'],
    ['truncated at max tokens', textResponse('{"a":', 'length'), 'truncated'],
  ])('structured: %s → %s', async (_n, res, kind) => {
    await expect(new GroqProvider(new FakeGroqClient([res]), cfg).structured({ stage: 'r', messages: [], schemaName: 'r', schema: {}, maxOutputTokens: 8 })).rejects.toMatchObject({ kind });
  });
});

describe('API error mapping', () => {
  it.each([
    [401, { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } }, {}, 'auth', false, null],
    [429, { error: { message: 'Rate limit reached', type: 'tokens', code: 'rate_limit_exceeded' } }, { 'retry-after': '7' }, 'rate_limit', true, 7000],
    [498, { error: { message: 'flex capacity' } }, {}, 'capacity', true, null],
    [503, { error: { message: 'unavailable' } }, {}, 'capacity', true, null],
    [500, { error: { message: 'boom' } }, {}, 'server', true, null],
    [400, { error: { message: 'bad schema', code: 'json_validate_failed' } }, {}, 'invalid_generation', true, null],
    // observed live 2026-11-17: model emitted invalid args for log_volume; Groq rejected the sample
    [400, { error: { message: "Tool call validation failed: parameters for tool log_volume did not match schema: errors: [missing properties: 'window', additionalProperties 'i' not allowed]", type: 'invalid_request_error', code: 'tool_use_failed' } }, {}, 'invalid_generation', true, null],
    [400, { error: { message: 'messages: field required', type: 'invalid_request_error' } }, {}, 'bad_request', false, null],
    [413, { error: { message: 'too large' } }, {}, 'bad_request', false, null],
  ])('%i → %s', async (status, body, headers, kind, retryable, retryAfterMs) => {
    const e = mapGroqError(sdkError(status, body, headers));
    expect(e).toMatchObject({ kind, retryable, status, retryAfterMs });
  });

  it('carries provider error code', () => {
    expect(mapGroqError(sdkError(401, { error: { message: 'x', code: 'invalid_api_key' } })).providerCode).toBe('invalid_api_key');
  });

  it('maps timeout, connection and abort', () => {
    expect(mapGroqError(new Groq.APIConnectionTimeoutError()).kind).toBe('timeout');
    expect(mapGroqError(new Groq.APIConnectionError({ message: 'x' })).kind).toBe('connection');
    expect(mapGroqError(new Groq.APIUserAbortError()).kind).toBe('aborted');
    expect(mapGroqError(new Error('weird')).kind).toBe('unknown');
  });

  it('errors thrown through the provider are LlmErrors', async () => {
    const p = new GroqProvider(new FakeGroqClient([() => { throw sdkError(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }); }]), cfg);
    const err = await p.chat(chatReq).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.toJSON()).toEqual({ kind: 'rate_limit', message: 'slow down', status: 429, retryable: true, retryAfterMs: 2000, providerCode: null });
  });

  it('redacts key-like strings that appear in provider error messages', () => {
    const e = mapGroqError(sdkError(401, { error: { message: 'Invalid key gsk_abcdefghijklmnopqrstuvwxyz0123456789' } }));
    expect(e.message).not.toMatch(/gsk_[a-z0-9]{8}/);
    expect(JSON.stringify(e)).not.toContain('abcdefghijklmnop');
  });

  it('parses retry-after seconds and HTTP dates', () => {
    expect(parseRetryAfter('7.5')).toBe(7500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('garbage')).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 3000).toUTCString())).toBeGreaterThan(1000);
  });
});
