import { inspect } from 'node:util';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { ReportApi, TOOL_INPUTS, toApiJsonSchema } from '@traceops/contracts';
import { DeepSeekProvider, mapDeepSeekError, parseRetryAfter, redactDeepSeek, SUBMIT_REPORT_TOOL } from '../../../src/llm/deepseek/adapter.ts';
import { loadDeepSeekConfig } from '../../../src/llm/deepseek/config.ts';
import { deepseekStrictProblems, toDeepSeekWireSchema } from '../../../src/llm/deepseek/schema.ts';
import { createDeepSeekProvider } from '../../../src/llm/deepseek/index.ts';
import { LlmError } from '../../../src/llm/errors.ts';
import { MemoryRecorder, RecordingProvider, toLlmCallRow } from '../../../src/llm/recorder.ts';
import { selectedProvider } from '../../../src/llm/index.ts';
import { FakeDeepSeekClient, textResponse, toolResponse } from './fakes.ts';

const cfg = { model: 'deepseek-flash' };
const obj = { type: 'object', properties: {}, required: [], additionalProperties: false };
const chatReq = { stage: 't', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxOutputTokens: 64 };
const structReq = (schema: Record<string, unknown> = obj) => ({ stage: 'report', messages: [{ role: 'user' as const, content: 'x' }], schemaName: 'investigation_report', schema, maxOutputTokens: 64 });
const sdkError = (status: number, body: object, headers: Record<string, string> = {}) => OpenAI.APIError.generate(status, body, undefined, new Headers(headers));
const FAKE_KEY = 'sk-0123456789abcdef0123456789abcdef';

describe('chat()', () => {
  it('maps text, stop reason, usage, model and request id', async () => {
    const r = await new DeepSeekProvider(new FakeDeepSeekClient([textResponse('hello')]), cfg).chat(chatReq);
    expect(r).toMatchObject({ content: 'hello', toolCalls: [], stopReason: 'end' });
    expect(r.meta).toEqual({ provider: 'deepseek', model: 'deepseek-flash', requestId: 'ds-req-1', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, providerTimings: null });
  });

  it('usage is null (never zero-filled) when the provider reports none', async () => {
    const res = { ...textResponse('x'), usage: undefined };
    expect((await new DeepSeekProvider(new FakeDeepSeekClient([res]), cfg).chat(chatReq)).meta.usage).toBeNull();
  });

  it('sends every tool with strict:true, tool_choice auto and thinking disabled', async () => {
    const client = new FakeDeepSeekClient([textResponse('ok')]);
    await new DeepSeekProvider(client, cfg).chat({
      stage: 't', maxOutputTokens: 64,
      tools: Object.entries(TOOL_INPUTS).map(([name, s]) => ({ name, description: `d ${name}`, parameters: toApiJsonSchema(s) })),
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'query_metric', argumentsJson: '{}' }] },
        { role: 'tool', toolCallId: 'c1', name: 'query_metric', content: '<tool_data>1</tool_data>' },
      ],
    });
    const body = client.bodies[0]!;
    expect(body).toMatchObject({ model: 'deepseek-flash', max_tokens: 64, thinking: { type: 'disabled' }, tool_choice: 'auto' });
    const tools = body.tools as Array<{ type: string; function: { name: string; strict: boolean; parameters: unknown } }>;
    expect(tools.map((t) => t.function.name)).toEqual(Object.keys(TOOL_INPUTS));
    for (const t of tools) {
      expect(t.type).toBe('function');
      expect(t.function.strict).toBe(true);
      expect(t.function.parameters).toEqual(toApiJsonSchema(TOOL_INPUTS[t.function.name as keyof typeof TOOL_INPUTS]));
    }
    expect(body.messages).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'query_metric', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '<tool_data>1</tool_data>' },
    ]);
    expect(body).not.toHaveProperty('response_format');
  });

  it('omits tools and tool_choice when there are none', async () => {
    const client = new FakeDeepSeekClient([textResponse('ok')]);
    await new DeepSeekProvider(client, cfg).chat(chatReq);
    expect(client.bodies[0]).not.toHaveProperty('tools');
    expect(client.bodies[0]).not.toHaveProperty('tool_choice');
  });

  it('parses tool calls and keeps raw argument strings', async () => {
    const r = await new DeepSeekProvider(new FakeDeepSeekClient([toolResponse([{ id: 'fc_1', name: 'log_volume', arguments: '{"a":1}' }])]), cfg).chat(chatReq);
    expect(r.stopReason).toBe('tool_calls');
    expect(r.toolCalls).toEqual([{ id: 'fc_1', name: 'log_volume', argumentsJson: '{"a":1}' }]);
  });

  it.each([['length', 'length'], ['stop', 'end'], ['something_new', 'other']])('finish_reason %s → %s', async (f, stop) => {
    expect((await new DeepSeekProvider(new FakeDeepSeekClient([textResponse('x', f)]), cfg).chat(chatReq)).stopReason).toBe(stop);
  });

  it.each([['content_filter', 'unknown'], ['insufficient_system_resource', 'capacity']])('finish_reason %s → LlmError %s (see finish-and-headers.test.ts)', async (f, kind) => {
    await expect(new DeepSeekProvider(new FakeDeepSeekClient([textResponse('x', f)]), cfg).chat(chatReq)).rejects.toMatchObject({ kind });
  });

  it.each([
    ['no choices', {}],
    ['empty choices', { choices: [] }],
    ['null message', { choices: [{ message: null }] }],
    ['tool_calls not array', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: 'x' } }] }],
    ['tool call without name', { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'a', function: {} }] } }] }],
  ])('%s → malformed_response', async (_n, res) => {
    await expect(new DeepSeekProvider(new FakeDeepSeekClient([res]), cfg).chat(chatReq)).rejects.toMatchObject({ kind: 'malformed_response' });
  });
});

describe('structured(): forced strict submit_report tool call', () => {
  it('sends one strict tool, forces it, never uses response_format, and parses its arguments', async () => {
    const client = new FakeDeepSeekClient([toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '{"a":1}' }], 'stop')]);
    const r = await new DeepSeekProvider(client, cfg).structured(structReq());
    expect(r.value).toEqual({ a: 1 });
    expect(r.rawText).toBe('{"a":1}');
    expect(r.meta.requestId).toBe('ds-req-2');
    const body = client.bodies[0]!;
    expect(body).not.toHaveProperty('response_format');
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_report' } });
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'submit_report', description: expect.stringContaining('investigation_report'), parameters: obj, strict: true } }]);
  });

  it('passes the real ReportApi schema unchanged (it has no strippable keywords)', async () => {
    const client = new FakeDeepSeekClient([toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '{}' }])]);
    await new DeepSeekProvider(client, cfg).structured(structReq(toApiJsonSchema(ReportApi)));
    expect((client.bodies[0]!.tools as any)[0].function.parameters).toEqual(toApiJsonSchema(ReportApi));
  });

  it.each([
    ['no tool call', textResponse('{"a":1}'), 'malformed_response'],
    ['a different tool', toolResponse([{ name: 'other', arguments: '{}' }]), 'malformed_response'],
    ['empty arguments', toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '' }]), 'malformed_response'],
    ['non-JSON arguments', toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '{"a":' }]), 'malformed_response'],
    ['truncated', toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '{"a":' }], 'length'), 'truncated'],
  ])('%s → %s', async (_n, res, kind) => {
    await expect(new DeepSeekProvider(new FakeDeepSeekClient([res]), cfg).structured(structReq())).rejects.toMatchObject({ kind });
  });
});

describe('error mapping (DeepSeek error codes)', () => {
  it.each([
    [400, { error: { message: 'Invalid request body', type: 'invalid_request_error' } }, {}, 'bad_request', false, null],
    [401, { error: { message: 'Authentication Fails', type: 'authentication_error' } }, {}, 'auth', false, null],
    [402, { error: { message: 'Insufficient Balance' } }, {}, 'auth', false, null],
    [403, { error: { message: 'forbidden' } }, {}, 'auth', false, null],
    [408, { error: { message: 'timeout' } }, {}, 'timeout', true, null],
    [413, { error: { message: 'too large' } }, {}, 'bad_request', false, null],
    [422, { error: { message: 'Invalid Parameters' } }, {}, 'bad_request', false, null],
    [429, { error: { message: 'Rate Limit Reached' } }, { 'retry-after': '3' }, 'rate_limit', true, 3000],
    [429, { error: { message: 'Rate Limit Reached' } }, {}, 'rate_limit', true, null],
    [500, { error: { message: 'Server Error' } }, {}, 'server', true, null],
    [503, { error: { message: 'Server Overloaded' } }, {}, 'capacity', true, null],
    [504, { error: { message: 'Gateway Timeout' } }, {}, 'server', true, null],
  ])('%i → %s', (status, body, headers, kind, retryable, retryAfterMs) => {
    expect(mapDeepSeekError(sdkError(status, body, headers))).toMatchObject({ kind, retryable, status, retryAfterMs });
  });

  it('maps timeout, connection, abort and unknown', () => {
    expect(mapDeepSeekError(new OpenAI.APIConnectionTimeoutError()).kind).toBe('timeout');
    expect(mapDeepSeekError(new OpenAI.APIConnectionError({ message: 'x' })).kind).toBe('connection');
    expect(mapDeepSeekError(new OpenAI.APIUserAbortError()).kind).toBe('aborted');
    expect(mapDeepSeekError(new Error('weird')).kind).toBe('unknown');
  });

  it('errors thrown through the provider are LlmErrors', async () => {
    const p = new DeepSeekProvider(new FakeDeepSeekClient([() => { throw sdkError(429, { error: { message: 'slow down' } }, { 'retry-after': '2' }); }]), cfg);
    const err = await p.chat(chatReq).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.toJSON()).toMatchObject({ kind: 'rate_limit', message: 'slow down', status: 429, retryable: true, retryAfterMs: 2000 });
  });

  it('redacts DeepSeek-style keys from error messages', () => {
    const e = mapDeepSeekError(sdkError(401, { error: { message: `Invalid key ${FAKE_KEY}` } }));
    expect(e.message).not.toContain('0123456789abcdef');
    expect(redactDeepSeek(`x ${FAKE_KEY} y`)).toBe('x sk-[REDACTED] y');
  });

  it('parses retry-after seconds and HTTP dates', () => {
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
  });
});

describe('llm_calls rows', () => {
  const trace = { investigationId: '00000000-0000-4000-8000-000000000001', turn: 1 };
  it('ok and error attempts become valid provider-neutral rows with provider "deepseek"', async () => {
    const rec = new MemoryRecorder();
    const p = new RecordingProvider(new DeepSeekProvider(new FakeDeepSeekClient([
      () => { throw sdkError(503, { error: { message: 'Server Overloaded' } }); },
      toolResponse([{ name: 'query_metric', arguments: '{}' }]),
      toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '{}' }]),
    ]), cfg), rec);
    await p.chat({ ...chatReq, stage: 'investigate', trace }).catch(() => {});
    await p.chat({ ...chatReq, stage: 'investigate', trace });
    await p.structured({ ...structReq(), trace: { ...trace, turn: 2 } });
    const rows = rec.records.map((r) => toLlmCallRow(r));
    expect(rows.map((r) => [r.provider, r.kind, r.status, r.attempt, r.error_kind, r.stop_reason, r.tool_call_count])).toEqual([
      ['deepseek', 'chat', 'error', 1, 'capacity', null, null],
      ['deepseek', 'chat', 'ok', 2, null, 'tool_calls', 1],
      ['deepseek', 'structured', 'ok', 1, null, 'end', null],
    ]);
    expect(rows[1]).toMatchObject({ model: 'deepseek-flash', request_id: 'ds-req-2', input_tokens: 100, output_tokens: 20, cache_read_tokens: null });
  });
});

describe('config', () => {
  it('defaults from LLM_DEFAULTS.deepseek', () => {
    const c = loadDeepSeekConfig({ DEEPSEEK_API_KEY: FAKE_KEY });
    expect(c).toMatchObject({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: 30000 });
  });

  it('honours overrides and strips trailing slashes', () => {
    expect(loadDeepSeekConfig({ DEEPSEEK_API_KEY: FAKE_KEY, DEEPSEEK_BASE_URL: 'http://localhost:9/', DEEPSEEK_MODEL: 'deepseek-v4-pro', DEEPSEEK_TIMEOUT_MS: '5000' }))
      .toMatchObject({ baseUrl: 'http://localhost:9', model: 'deepseek-v4-pro', timeoutMs: 5000 });
  });

  it('requires DEEPSEEK_API_KEY', () => {
    expect(() => loadDeepSeekConfig({})).toThrow(/DEEPSEEK_API_KEY is not set/);
    expect(() => loadDeepSeekConfig({ DEEPSEEK_API_KEY: '  ' })).toThrow(/DEEPSEEK_API_KEY is not set/);
  });

  it.each([
    [{ DEEPSEEK_BASE_URL: 'https://api.deepseek.com/beta' }, /API host/],
    [{ DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1' }, /API host/],
    [{ DEEPSEEK_BASE_URL: 'http://api.deepseek.com' }, /https/],
    [{ DEEPSEEK_BASE_URL: 'not a url' }, /valid URL/],
    [{ DEEPSEEK_TIMEOUT_MS: '0' }, /positive integer/],
  ])('rejects %j', (env, err) => {
    expect(() => loadDeepSeekConfig({ DEEPSEEK_API_KEY: FAKE_KEY, ...env })).toThrow(err);
  });

  it('never exposes the key through JSON, inspect or String', () => {
    const c = loadDeepSeekConfig({ DEEPSEEK_API_KEY: FAKE_KEY });
    for (const s of [JSON.stringify(c), inspect(c, { depth: 5 }), String(c.apiKey)]) expect(s).not.toContain(FAKE_KEY);
  });

  it('factory builds a recording provider named deepseek without any network call', () => {
    const p = createDeepSeekProvider(new MemoryRecorder(), { DEEPSEEK_API_KEY: FAKE_KEY });
    expect([p.name, p.model]).toEqual(['deepseek', 'deepseek-flash']);
  });

  it('LLM_PROVIDER=deepseek is a recognised provider', () => {
    expect(selectedProvider({ LLM_PROVIDER: 'deepseek' })).toBe('deepseek');
  });
});

describe('strict-schema compatibility', () => {
  it('ReportApi and all four tool schemas have no DeepSeek problems', () => {
    expect(deepseekStrictProblems(toApiJsonSchema(ReportApi))).toEqual({ strippable: [], structural: [] });
    for (const s of Object.values(TOOL_INPUTS)) expect(deepseekStrictProblems(toApiJsonSchema(s))).toEqual({ strippable: [], structural: [] });
  });

  it('classifies constraint keywords as strippable and structural keywords as not', () => {
    const p = deepseekStrictProblems({ type: 'object', properties: { a: { type: 'string', maxLength: 3 }, b: { type: 'array', items: { type: 'string' }, minItems: 1 }, c: { oneOf: [{ type: 'string' }] } }, required: ['a', 'b', 'c'], additionalProperties: false });
    expect(p.strippable.join('\n')).toMatch(/maxLength/);
    expect(p.strippable.join('\n')).toMatch(/minItems/);
    expect(p.structural.join('\n')).toMatch(/oneOf/);
    expect(p.structural.join('\n')).not.toMatch(/maxLength|minItems/);
  });

  it('flags optional properties, open objects and unsupported formats as structural', () => {
    const p = deepseekStrictProblems({ type: 'object', properties: { a: { type: 'string', format: 'date-time' }, b: { type: 'object', properties: {} } }, required: ['b'] });
    const s = p.structural.join('\n');
    expect(s).toMatch(/optional properties/);
    expect(s).toMatch(/additionalProperties:false/);
    expect(s).toMatch(/format "date-time"/);
  });
});

describe('toDeepSeekWireSchema (pure)', () => {
  const input = {
    type: 'object', additionalProperties: false, required: ['minLength', 'list'],
    properties: {
      minLength: { type: 'string', minLength: 1, maxLength: 9 }, // a PROPERTY named like a keyword is kept
      list: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: { anyOf: [{ type: 'string', maxLength: 2 }, { type: 'null' }] } },
    },
    $defs: { maxItems: { type: 'string', minLength: 2 } },
  };

  it('removes constraint keywords everywhere but keeps property names and structure', () => {
    expect(toDeepSeekWireSchema(input)).toEqual({
      type: 'object', additionalProperties: false, required: ['minLength', 'list'],
      properties: { minLength: { type: 'string' }, list: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } } },
      $defs: { maxItems: { type: 'string' } },
    });
  });

  it('does not mutate its input and is a no-op on clean schemas', () => {
    const before = structuredClone(input);
    toDeepSeekWireSchema(input);
    expect(input).toEqual(before);
    const report = toApiJsonSchema(ReportApi);
    expect(toDeepSeekWireSchema(report)).toEqual(report);
  });

  it('the stripped schema has no strippable problems left', () => {
    expect(deepseekStrictProblems(toDeepSeekWireSchema(input)).strippable).toEqual([]);
  });

  it('the adapter sends the stripped schema on the wire', async () => {
    const client = new FakeDeepSeekClient([textResponse('ok')]);
    await new DeepSeekProvider(client, cfg).chat({ ...chatReq, tools: [{ name: 'x', description: 'd', parameters: input }] });
    expect((client.bodies[0]!.tools as any)[0].function.parameters).toEqual(toDeepSeekWireSchema(input));
  });
});
