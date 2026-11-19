/**
 * DEV/TEST ONLY: an LlmProvider that replays a script of chat/structured
 * responses. No network. Used by investigator tests and to seed the dev API.
 */
import type { ChatRequest, ChatResult, LlmError, LlmProvider, StructuredRequest, StructuredResult, ToolCall } from '../../llm/index.ts';

export type ChatStep = { kind: 'chat'; toolCalls?: Array<{ name: string; args: unknown }>; content?: string } | { kind: 'chat_error'; error: LlmError };
export type StructuredStep = { kind: 'structured'; value: unknown } | { kind: 'structured_error'; error: LlmError };
export type Step = ChatStep | StructuredStep;

export class ScriptedProvider implements LlmProvider {
  /** A provider name from LLM_PROVIDERS so recorded calls map onto llm_calls rows; no network is involved. */
  readonly name = 'groq';
  readonly model: string;
  readonly requests: Array<{ kind: 'chat' | 'structured'; stage: string; turn: number | undefined; req: ChatRequest | StructuredRequest }> = [];
  private n = 0;
  private readonly steps: Step[];

  /** `loopChat`: returned for every chat request once the scripted chat steps are used up (budget tests). */
  constructor(steps: Step[], private readonly opts: { loopChat?: ChatStep; model?: string } = {}) {
    this.steps = [...steps];
    this.model = opts.model ?? 'fake-model';
  }

  private meta() {
    return { provider: this.name, model: this.model, requestId: 'req_scripted', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, providerTimings: null };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { signal: _s, ...rest } = req;
    this.requests.push({ kind: 'chat', stage: req.stage, turn: req.trace?.turn, req: structuredClone(rest) });
    const head = this.steps[0];
    const step = head && (head.kind === 'chat' || head.kind === 'chat_error') ? (this.steps.shift() as ChatStep) : this.opts.loopChat;
    if (!step) throw new Error(`scripted: expected a chat step, got ${head?.kind ?? 'nothing'}`);
    if (step.kind === 'chat_error') throw step.error;
    const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((c) => ({ id: `call_${++this.n}`, name: c.name, argumentsJson: JSON.stringify(c.args) }));
    return { content: step.content ?? null, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : 'end', meta: this.meta() };
  }

  async structured(req: StructuredRequest): Promise<StructuredResult> {
    const { signal: _s, ...rest } = req;
    this.requests.push({ kind: 'structured', stage: req.stage, turn: req.trace?.turn, req: structuredClone(rest) });
    const step = this.steps.shift();
    if (!step || (step.kind !== 'structured' && step.kind !== 'structured_error')) throw new Error(`scripted: expected a structured step, got ${step?.kind ?? 'nothing'}`);
    if (step.kind === 'structured_error') throw step.error;
    return { value: step.value, rawText: JSON.stringify(step.value), meta: this.meta() };
  }
}
