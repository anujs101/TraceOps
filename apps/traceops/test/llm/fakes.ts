import type { GroqChatClient } from '../../src/llm/groq/adapter.ts';

/** Fake Groq client: returns queued responses (or throws queued errors) and records request bodies. */
export class FakeGroqClient implements GroqChatClient {
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

export const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, queue_time: 0.1, prompt_time: 0.01, completion_time: 0.05, total_time: 0.06 };

export function textResponse(content: string, finish = 'stop') {
  return { id: 'chatcmpl-1', model: 'openai/gpt-oss-20b', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }], usage, x_groq: { id: 'req_test' } };
}

export function toolResponse(calls: Array<{ id?: string; name: string; arguments: string }>) {
  return {
    id: 'chatcmpl-2', model: 'openai/gpt-oss-20b', usage, x_groq: { id: 'req_tool' },
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls.map((c, i) => ({ id: c.id ?? `call_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } })) } }],
  };
}
