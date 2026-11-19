import OpenAI from 'openai';
import { LlmError, redactSecrets } from '../errors.ts';
import type { CallMeta, ChatRequest, ChatResult, LlmMessage, LlmProvider, StopReason, StructuredRequest, StructuredResult, ToolCall } from '../types.ts';
import { DEEPSEEK_BETA_PATH, type DeepSeekConfig } from './config.ts';
import { toDeepSeekWireSchema } from './schema.ts';

/** The subset of the OpenAI-compatible client we use (injectable for tests). */
export type DeepSeekChatClient = {
  chat: { completions: { create(body: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown> } };
};

/** Name of the single forced tool that carries the structured report (DeepSeek has no json_schema response_format). */
export const SUBMIT_REPORT_TOOL = 'submit_report';

/**
 * Request headers sent to DeepSeek. Everything else is dropped: the openai SDK otherwise adds
 * OPENAI_CUSTOM_HEADERS (read from process.env at construction, not switchable by an option)
 * and OpenAI-Organization / OpenAI-Project to every request.
 */
const ALLOWED_HEADERS = /^(authorization|content-type|content-length|accept|accept-encoding|user-agent|x-stainless-[a-z0-9-]+)$/i;

export const deepSeekFetch = (inner: typeof fetch = fetch): typeof fetch => (input, init) => {
  const kept = new Headers();
  new Headers(init?.headers).forEach((v, k) => { if (ALLOWED_HEADERS.test(k)) kept.set(k, v); });
  return inner(input, { ...init, headers: kept });
};

export function createDeepSeekClient(cfg: DeepSeekConfig, fetchImpl: typeof fetch = fetch): DeepSeekChatClient {
  // SDK retries off: retries happen in withRetry() so every attempt is recorded.
  // /beta is required for strict tool schemas; baseURL is explicit so OPENAI_BASE_URL is never picked up.
  // organization/project/adminAPIKey/webhookSecret are explicit nulls so OPENAI_* env vars are never picked up;
  // deepSeekFetch drops any header outside the allowlist (OPENAI_CUSTOM_HEADERS).
  return new OpenAI({
    apiKey: cfg.apiKey.reveal(), baseURL: cfg.baseUrl + DEEPSEEK_BETA_PATH, maxRetries: 0, timeout: cfg.timeoutMs,
    organization: null, project: null, adminAPIKey: null, webhookSecret: null, fetch: deepSeekFetch(fetchImpl),
  }) as unknown as DeepSeekChatClient;
}

/**
 * DeepSeek adapter (Contracts v1.2, environment.md §6).
 *  - non-thinking mode always (`thinking: disabled`): fast, and a named tool_choice is a 400 in thinking mode
 *  - chat(): tools with strict:true, tool_choice auto
 *  - structured(): one strict tool `submit_report` with the report schema, forced via tool_choice;
 *    its argument JSON is the structured value. Report / V0–V8 validation runs afterwards, unchanged.
 */
export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  constructor(private readonly client: DeepSeekChatClient, private readonly cfg: Pick<DeepSeekConfig, 'model'>) {}
  get model() { return this.cfg.model; }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toDeepSeekMessages(req.messages),
      max_tokens: req.maxOutputTokens,
      thinking: { type: 'disabled' },
      ...(req.tools.length ? { tools: req.tools.map((t) => strictTool(t.name, t.description, t.parameters)), tool_choice: 'auto' } : {}),
    };
    const res = await this.send(body, req.signal);
    const choice = firstChoice(res);
    throwOnServerStop(choice.finish_reason);
    const msg = choice.message as Record<string, unknown>;
    const toolCalls = parseToolCalls(msg.tool_calls);
    return { content: typeof msg.content === 'string' ? msg.content : null, toolCalls, stopReason: mapFinish(choice.finish_reason, toolCalls.length), meta: this.meta(res) };
  }

  async structured(req: StructuredRequest): Promise<StructuredResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toDeepSeekMessages(req.messages),
      max_tokens: req.maxOutputTokens,
      thinking: { type: 'disabled' },
      tools: [strictTool(SUBMIT_REPORT_TOOL, `Submit the final ${req.schemaName}. Call this exactly once with the complete result.`, req.schema)],
      tool_choice: { type: 'function', function: { name: SUBMIT_REPORT_TOOL } },
    };
    const res = await this.send(body, req.signal);
    const choice = firstChoice(res);
    throwOnServerStop(choice.finish_reason);
    if (choice.finish_reason === 'length') throw new LlmError('truncated', 'structured output stopped at max tokens');
    const call = parseToolCalls((choice.message as Record<string, unknown>).tool_calls).find((c) => c.name === SUBMIT_REPORT_TOOL);
    if (!call || call.argumentsJson.trim() === '') throw new LlmError('malformed_response', `structured response has no ${SUBMIT_REPORT_TOOL} tool call`);
    let value: unknown;
    try { value = JSON.parse(call.argumentsJson); } catch { throw new LlmError('malformed_response', 'structured response is not valid JSON'); }
    return { value, rawText: call.argumentsJson, meta: this.meta(res) };
  }

  private async send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const res = await this.client.chat.completions.create(body, { signal });
      if (!res || typeof res !== 'object') throw new LlmError('malformed_response', 'empty response');
      return res as Record<string, unknown>;
    } catch (e) {
      throw mapDeepSeekError(e);
    }
  }

  private meta(res: Record<string, unknown>): CallMeta {
    const u = res.usage as Record<string, unknown> | undefined;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const inTok = num(u?.prompt_tokens), outTok = num(u?.completion_tokens);
    return {
      provider: 'deepseek',
      model: typeof res.model === 'string' && res.model ? res.model : this.cfg.model,
      requestId: typeof res.id === 'string' && res.id ? res.id : null,
      usage: inTok !== null && outTok !== null ? { inputTokens: inTok, outputTokens: outTok, totalTokens: num(u?.total_tokens) ?? inTok + outTok } : null,
      providerTimings: null, // DeepSeek reports no timings
    };
  }
}

function strictTool(name: string, description: string, parameters: Record<string, unknown>) {
  return { type: 'function', function: { name, description, parameters: toDeepSeekWireSchema(parameters), strict: true } };
}

function toDeepSeekMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system': case 'user': return { role: m.role, content: m.content };
      case 'assistant': return {
        role: 'assistant', content: m.content ?? '',
        ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.argumentsJson } })) } : {}),
      };
      case 'tool': return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
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

/**
 * DeepSeek-specific finish reasons that mean the output is not usable as returned:
 *  - insufficient_system_resource: the server cut generation off (capacity) → retryable `capacity`
 *  - content_filter: output withheld by the provider → `unknown` (not retried; not a model-format problem)
 */
function throwOnServerStop(reason: unknown): void {
  if (reason === 'insufficient_system_resource') throw new LlmError('capacity', 'DeepSeek stopped generation: insufficient system resource');
  if (reason === 'content_filter') throw new LlmError('unknown', 'DeepSeek withheld the output (content_filter)');
}

function mapFinish(reason: unknown, toolCalls: number): StopReason {
  // truncation wins over the tool-call shortcut: partial tool calls cut at max tokens are a `length` stop
  if (reason === 'length') return 'length';
  if (toolCalls > 0 || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'stop') return 'end';
  return 'other';
}

/** DeepSeek keys look like `sk-<32 hex>`; the shared redactSecrets() doesn't know that prefix. */
export function redactDeepSeek(text: string): string {
  return redactSecrets(text).replace(/sk-[A-Za-z0-9]{16,}/g, 'sk-[REDACTED]');
}

/**
 * DeepSeek error codes (api-docs.deepseek.com/quick_start/error_codes, 2026-11-19) → LLM_ERROR_KINDS.
 * 402 (insufficient balance) is `auth`: not retryable, needs an operator. DeepSeek documents no
 * model-output rejection code, so no 400 maps to `invalid_generation` until one is observed live.
 */
export function mapDeepSeekError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof OpenAI.APIUserAbortError) return new LlmError('aborted', 'request aborted');
  if (e instanceof OpenAI.APIConnectionTimeoutError) return new LlmError('timeout', 'request timed out');
  if (e instanceof OpenAI.APIConnectionError) return new LlmError('connection', 'connection error');
  if (e instanceof OpenAI.APIError) {
    const status = typeof e.status === 'number' ? e.status : null;
    const body = (e.error ?? {}) as Record<string, any>;
    const inner = (body.error ?? body) as Record<string, any>;
    const code = typeof e.code === 'string' ? e.code : typeof inner.code === 'string' ? inner.code : typeof inner.type === 'string' ? inner.type : null;
    const msg = redactDeepSeek(typeof inner.message === 'string' ? inner.message : e.message ?? 'API error');
    const retryAfter = parseRetryAfter(headerValue(e.headers, 'retry-after'));
    const kind =
      status === 401 || status === 402 || status === 403 ? 'auth' :
      status === 408 ? 'timeout' :
      status === 429 ? 'rate_limit' :
      status === 503 ? 'capacity' :
      status !== null && status >= 500 ? 'server' :
      status !== null && status >= 400 ? 'bad_request' : 'unknown';
    return new LlmError(kind, msg, { status, retryAfterMs: retryAfter, providerCode: code });
  }
  return new LlmError('unknown', redactDeepSeek(e instanceof Error ? e.message : String(e)));
}

function headerValue(h: unknown, name: string): string | null {
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get(name);
  const v = (h as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : null;
}

/** retry-after in seconds (or HTTP-date). DeepSeek doesn't document the header; honoured if sent. */
export function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}
