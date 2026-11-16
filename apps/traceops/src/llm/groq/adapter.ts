import Groq from 'groq-sdk';
import { LlmError, redactSecrets } from '../errors.ts';
import type { CallMeta, ChatRequest, ChatResult, LlmMessage, LlmProvider, StopReason, StructuredRequest, StructuredResult, ToolCall } from '../types.ts';
import type { GroqConfig } from './config.ts';

/** The subset of the Groq client we use (injectable for tests). */
export type GroqChatClient = {
  chat: { completions: { create(body: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> } };
};

export function createGroqClient(cfg: GroqConfig): GroqChatClient {
  // SDK retries off: retries happen in withRetry() so every attempt is recorded.
  return new Groq({ apiKey: cfg.apiKey.reveal(), maxRetries: 0, timeout: cfg.timeoutMs }) as unknown as GroqChatClient;
}

export class GroqProvider implements LlmProvider {
  readonly name = 'groq';
  constructor(private readonly client: GroqChatClient, private readonly cfg: Pick<GroqConfig, 'model' | 'reasoningEffort'>) {}
  get model() { return this.cfg.model; }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toGroqMessages(req.messages),
      max_completion_tokens: req.maxOutputTokens,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: 'auto' } : {}),
      ...(this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
    };
    const res = await this.send(body, req.signal);
    const choice = firstChoice(res);
    const msg = choice.message as Record<string, unknown>;
    const toolCalls = parseToolCalls(msg.tool_calls);
    return { content: typeof msg.content === 'string' ? msg.content : null, toolCalls, stopReason: mapFinish(choice.finish_reason, toolCalls.length), meta: this.meta(res) };
  }

  async structured(req: StructuredRequest): Promise<StructuredResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toGroqMessages(req.messages),
      max_completion_tokens: req.maxOutputTokens,
      response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
      ...(this.cfg.reasoningEffort ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
    };
    const res = await this.send(body, req.signal);
    const choice = firstChoice(res);
    if (choice.finish_reason === 'length') throw new LlmError('truncated', 'structured output stopped at max tokens');
    const text = (choice.message as Record<string, unknown>).content;
    if (typeof text !== 'string' || text.trim() === '') throw new LlmError('malformed_response', 'structured response has no content');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new LlmError('malformed_response', 'structured response is not valid JSON'); }
    return { value, rawText: text, meta: this.meta(res) };
  }

  private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const res = await this.client.chat.completions.create(body, { signal });
      if (!res || typeof res !== 'object') throw new LlmError('malformed_response', 'empty response');
      return res as Record<string, unknown>;
    } catch (e) {
      throw mapGroqError(e);
    }
  }

  private meta(res: Record<string, unknown>): CallMeta {
    const u = res.usage as Record<string, unknown> | undefined;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const timings: Record<string, number> = {};
    for (const k of ['queue_time', 'prompt_time', 'completion_time', 'total_time']) {
      const v = num(u?.[k]);
      if (v !== null) timings[k.replace('_time', '_ms')] = Math.round(v * 1000);
    }
    const inTok = num(u?.prompt_tokens), outTok = num(u?.completion_tokens);
    return {
      provider: 'groq',
      model: typeof res.model === 'string' ? res.model : this.cfg.model,
      requestId: typeof (res.x_groq as Record<string, unknown> | undefined)?.id === 'string' ? ((res.x_groq as Record<string, unknown>).id as string) : (typeof res.id === 'string' ? res.id : null),
      usage: inTok !== null && outTok !== null ? { inputTokens: inTok, outputTokens: outTok, totalTokens: num(u?.total_tokens) ?? inTok + outTok } : null,
      providerTimings: Object.keys(timings).length ? timings : null,
    };
  }
}

function toGroqMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system': case 'user': return { role: m.role, content: m.content };
      case 'assistant': return {
        role: 'assistant', content: m.content ?? '',
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argumentsJson } })) } : {}),
      };
      case 'tool': return { role: 'tool', tool_call_id: m.toolCallId, name: m.name, content: m.content };
    }
  });
}

function firstChoice(res: Record<string, unknown>): { message: unknown; finish_reason: unknown } {
  const choices = res.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !choices[0] || typeof choices[0].message !== 'object' || choices[0].message === null)
    throw new LlmError('malformed_response', 'response has no choices[0].message');
  return choices[0];
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new LlmError('malformed_response', 'tool_calls is not an array');
  return raw.map((t, i) => {
    const fn = (t as Record<string, any>)?.function;
    if (!fn || typeof fn.name !== 'string') throw new LlmError('malformed_response', `tool_calls[${i}] missing function.name`);
    return {
      id: typeof t.id === 'string' && t.id ? t.id : `call_${i}`,
      name: fn.name,
      argumentsJson: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    };
  });
}

function mapFinish(reason: unknown, toolCalls: number): StopReason {
  if (toolCalls > 0 || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'stop') return 'end';
  if (reason === 'length') return 'length';
  return 'other';
}

export function mapGroqError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Groq.APIUserAbortError) return new LlmError('aborted', 'request aborted');
  if (e instanceof Groq.APIConnectionTimeoutError) return new LlmError('timeout', 'request timed out');
  if (e instanceof Groq.APIConnectionError) return new LlmError('connection', 'connection error');
  if (e instanceof Groq.APIError) {
    const status = typeof e.status === 'number' ? e.status : null;
    const body = (e.error ?? {}) as Record<string, any>;
    const inner = (body.error ?? body) as Record<string, any>;
    const code = typeof inner.code === 'string' ? inner.code : typeof inner.type === 'string' ? inner.type : null;
    const msg = redactSecrets(typeof inner.message === 'string' ? inner.message : e.message ?? 'API error');
    const retryAfter = parseRetryAfter(headerValue(e.headers, 'retry-after'));
    // Groq validates the model's tool-call arguments / best-effort JSON server-side and
    // returns 400 when the SAMPLE is invalid (observed live: tool_use_failed). The request
    // itself is fine, so this is a retryable re-sample, not a bad_request.
    const kind =
      status === 400 && (code === 'tool_use_failed' || code === 'json_validate_failed') ? 'invalid_generation' :
      status === 401 || status === 403 ? 'auth' :
      status === 429 ? 'rate_limit' :
      status === 498 || status === 503 ? 'capacity' :
      status !== null && status >= 500 ? 'server' :
      status !== null && status >= 400 ? 'bad_request' : 'unknown';
    return new LlmError(kind, msg, { status, retryAfterMs: retryAfter, providerCode: code });
  }
  return new LlmError('unknown', e instanceof Error ? e.message : String(e));
}

function headerValue(h: unknown, name: string): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const v = (h as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : null;
}

/** retry-after is in seconds per Groq docs; also accept HTTP-date. */
export function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}
