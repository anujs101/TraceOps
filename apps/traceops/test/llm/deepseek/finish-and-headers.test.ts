import { describe, expect, it } from 'vitest';
import { createDeepSeekClient, deepSeekFetch, DeepSeekProvider, SUBMIT_REPORT_TOOL } from '../../../src/llm/deepseek/adapter.ts';
import { loadDeepSeekConfig } from '../../../src/llm/deepseek/config.ts';
import { LlmError } from '../../../src/llm/errors.ts';
import { FakeDeepSeekClient, textResponse, toolResponse } from './fakes.ts';

const cfg = { model: 'deepseek-flash' };
const obj = { type: 'object', properties: {}, required: [], additionalProperties: false };
const chatReq = { stage: 't', messages: [{ role: 'user' as const, content: 'hi' }], tools: [], maxOutputTokens: 64 };
const structReq = { stage: 'report', messages: [{ role: 'user' as const, content: 'x' }], schemaName: 'investigation_report', schema: obj, maxOutputTokens: 64 };
const FAKE_KEY = 'sk-0123456789abcdef0123456789abcdef';

describe('DeepSeek finish reasons', () => {
  it('insufficient_system_resource is a retryable capacity error (chat and structured)', async () => {
    const cut = toolResponse([{ name: SUBMIT_REPORT_TOOL, arguments: '{"status":"pro' }], 'insufficient_system_resource');
    for (const call of [
      (p: DeepSeekProvider) => p.structured(structReq),
      (p: DeepSeekProvider) => p.chat(chatReq),
    ]) {
      const e = await call(new DeepSeekProvider(new FakeDeepSeekClient([cut]), cfg)).catch((x) => x);
      expect(e).toBeInstanceOf(LlmError);
      expect(e).toMatchObject({ kind: 'capacity', retryable: true });
    }
  });

  it('content_filter is surfaced as an error, not as malformed JSON', async () => {
    const e = await new DeepSeekProvider(new FakeDeepSeekClient([textResponse('', 'content_filter')]), cfg).structured(structReq).catch((x) => x);
    expect(e).toMatchObject({ kind: 'unknown', retryable: false });
    expect(e.message).toMatch(/content_filter/);
  });

  it('a tool-call turn cut at max tokens is a length stop, not tool_calls', async () => {
    const r = await new DeepSeekProvider(new FakeDeepSeekClient([toolResponse([{ name: 'query_metric', arguments: '{"metric":"po' }], 'length')]), cfg).chat(chatReq);
    expect(r.stopReason).toBe('length');
    expect(r.toolCalls).toHaveLength(1); // raw calls still reported; the loop sees a truncated turn
  });

  it('complete tool calls still map to tool_calls', async () => {
    const r = await new DeepSeekProvider(new FakeDeepSeekClient([toolResponse([{ name: 'query_metric', arguments: '{}' }])]), cfg).chat(chatReq);
    expect(r.stopReason).toBe('tool_calls');
  });
});

describe('DeepSeek request headers', () => {
  it('deepSeekFetch forwards only allowlisted headers', async () => {
    let sent: Headers | undefined;
    const f = deepSeekFetch(async (_u, init) => { sent = new Headers(init?.headers); return new Response('{}'); });
    await f('https://api.deepseek.com/beta/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer x', 'content-type': 'application/json', 'x-stainless-retry-count': '0', 'OpenAI-Organization': 'org_TEST000', 'OpenAI-Project': 'proj_x', 'X-Internal-Token': 'leak' },
    });
    expect([...sent!.keys()].sort()).toEqual(['authorization', 'content-type', 'x-stainless-retry-count']);
  });

  it('the real client sends no OPENAI_* org/project/custom headers to DeepSeek', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { OPENAI_ORG_ID: 'org_TEST000', OPENAI_PROJECT_ID: 'proj_TEST', OPENAI_CUSTOM_HEADERS: 'X-Internal-Token: leak\nX-Other: 1', OPENAI_BASE_URL: 'https://evil.invalid' });
    try {
      let url = '';
      let sent: Headers | undefined;
      const capture: typeof fetch = async (u, init) => {
        url = String(u); sent = new Headers(init?.headers);
        return new Response(JSON.stringify(textResponse('ok')), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const c = loadDeepSeekConfig({ DEEPSEEK_API_KEY: FAKE_KEY });
      await new DeepSeekProvider(createDeepSeekClient(c, capture), cfg).chat(chatReq);
      expect(url).toMatch(/^https:\/\/api\.deepseek\.com\/beta\//);
      for (const h of ['openai-organization', 'openai-project', 'x-internal-token', 'x-other']) expect(sent!.has(h)).toBe(false);
      expect(sent!.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    } finally {
      for (const k of ['OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_CUSTOM_HEADERS', 'OPENAI_BASE_URL']) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
