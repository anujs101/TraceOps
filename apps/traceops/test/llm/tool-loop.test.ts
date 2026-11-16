import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GroqProvider } from '../../src/llm/groq/adapter.ts';
import { runToolLoop, type LocalTool } from '../../src/llm/tool-loop.ts';
import { FakeGroqClient, textResponse, toolResponse } from './fakes.ts';

const cfg = { model: 'm', reasoningEffort: null };
const opts = { stage: 't', maxToolCalls: 3, maxTurns: 5, maxOutputTokens: 64 };
function adder(calls: unknown[]): LocalTool<{ a: number; b: number }> {
  return {
    spec: { name: 'add', description: 'add', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
    args: z.object({ a: z.number(), b: z.number().max(100) }).strict(),
    run: async (x) => { calls.push(x); return { sum: x.a + x.b }; },
  };
}
const run = (queue: unknown[], tools: LocalTool<any>[]) =>
  runToolLoop(new GroqProvider(new FakeGroqClient(queue), cfg), [{ role: 'user', content: 'go' }], tools, opts);

describe('tool loop', () => {
  it('executes the tool locally and feeds the result back as tool_data', async () => {
    const calls: unknown[] = [];
    const r = await run([toolResponse([{ id: 'c1', name: 'add', arguments: '{"a":2,"b":3}' }]), textResponse('5')], [adder(calls)]);
    expect(calls).toEqual([{ a: 2, b: 3 }]);
    expect(r.finalText).toBe('5');
    expect(r.toolRuns[0]).toMatchObject({ status: 'ok', result: { sum: 5 } });
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toMatchObject({ toolCallId: 'c1', content: '<tool_data call_id="c1">{"sum":5}</tool_data>' });
  });

  it.each([
    ['malformed JSON arguments', '{"a":2,', 'invalid_args'],
    ['schema-invalid arguments (server-side limit stricter than spec)', '{"a":2,"b":1000}', 'invalid_args'],
    ['extra properties', '{"a":1,"b":2,"cmd":"rm -rf /"}', 'invalid_args'],
  ])('%s → %s, tool not executed, model told', async (_n, args, status) => {
    const calls: unknown[] = [];
    const r = await run([toolResponse([{ name: 'add', arguments: args }]), textResponse('sorry')], [adder(calls)]);
    expect(calls).toEqual([]);
    expect(r.toolRuns[0]!.status).toBe(status);
    expect(r.messages.find((m) => m.role === 'tool')!.content).toContain(status);
  });

  it('unknown tool names are refused, not executed', async () => {
    const r = await run([toolResponse([{ name: 'shell_exec', arguments: '{"cmd":"cat .env"}' }]), textResponse('ok')], [adder([])]);
    expect(r.toolRuns[0]).toMatchObject({ status: 'unknown_tool', name: 'shell_exec' });
  });

  it('tool exceptions become tool_error results', async () => {
    const failing: LocalTool<{ a: number; b: number }> = { ...adder([]), run: async () => { throw new Error('backend down'); } };
    const r = await run([toolResponse([{ name: 'add', arguments: '{"a":1,"b":1}' }]), textResponse('noted')], [failing]);
    expect(r.toolRuns[0]).toMatchObject({ status: 'tool_error', result: 'backend down' });
  });

  it('enforces the tool-call budget', async () => {
    const calls: unknown[] = [];
    const call = toolResponse([{ name: 'add', arguments: '{"a":1,"b":1}' }]);
    const r = await runToolLoop(new GroqProvider(new FakeGroqClient([call, call, call, textResponse('done')]), cfg), [{ role: 'user', content: 'go' }], [adder(calls)], { ...opts, maxToolCalls: 2 });
    expect(calls).toHaveLength(2);
    expect(r.toolRuns.map((t) => t.status)).toEqual(['ok', 'ok', 'budget_exhausted']);
  });

  it('stops after maxTurns without a final answer', async () => {
    const call = toolResponse([{ name: 'add', arguments: '{"a":1,"b":1}' }]);
    const r = await runToolLoop(new GroqProvider(new FakeGroqClient([call, call]), cfg), [{ role: 'user', content: 'go' }], [adder([])], { ...opts, maxTurns: 2 });
    expect(r).toMatchObject({ finalText: null, stopReason: 'other', turns: 2 });
  });
});
