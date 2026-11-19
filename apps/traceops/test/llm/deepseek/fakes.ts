import type { DeepSeekChatClient } from '../../../src/llm/deepseek/adapter.ts';

/** Fake DeepSeek (OpenAI-compatible) client: returns queued responses (or throws queued errors) and records request bodies. */
export class FakeDeepSeekClient implements DeepSeekChatClient {
  readonly bodies: Record<string, unknown>[] = [];
  constructor(private readonly queue: Array<unknown | (() => never)>) {}
  chat = {
    completions: {
      create: async (body: Record<string, unknown>) => {
        this.bodies.push(structuredClone(body));
        const next = this.queue.shift();
        if (next === undefined) throw new Error('fake: no response queued');
        if (typeof next === 'function') return (next as () => never)();
        return next;
      },
    },
  };
}

export const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 };

export function textResponse(content: string, finish = 'stop') {
  return { id: 'ds-req-1', model: 'deepseek-flash', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }], usage };
}

export function toolResponse(calls: Array<{ id?: string; name: string; arguments: string }>, finish = 'tool_calls') {
  return {
    id: 'ds-req-2', model: 'deepseek-flash', usage,
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } })) } }],
  };
}
