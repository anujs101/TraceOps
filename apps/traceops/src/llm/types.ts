/**
 * Provider-neutral LLM interface. The investigator depends ONLY on this file
 * (and on errors.ts / recorder.ts). Provider SDKs live behind adapters such as
 * ./groq/adapter.ts and are never imported by investigator code.
 *
 * Two separate capabilities, because some providers (Groq) cannot combine
 * structured outputs with tool use in one request:
 *  - chat():       tool-calling turns (investigation stage)
 *  - structured(): one JSON-schema-constrained response (report stage)
 */

export type JsonSchema = Record<string, unknown>;

export type ToolCall = {
  id: string;
  name: string;
  /** Raw argument string exactly as the model produced it. Parsed by the tool loop, not the adapter. */
  argumentsJson: string;
};

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments (provider-compatible layer, e.g. contracts' *Input schemas). */
  parameters: JsonSchema;
};

export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

export type StopReason = 'tool_calls' | 'end' | 'length' | 'other';

export type CallMeta = {
  provider: string;
  model: string;
  /** Provider request id if available (never contains credentials). */
  requestId: string | null;
  usage: Usage | null;
  /** Provider-reported timings in ms, if available (e.g. Groq queue/prompt/completion time). */
  providerTimings: Record<string, number> | null;
};

export type ChatRequest = {
  stage: string; // e.g. "investigate" — recorded with the call
  messages: LlmMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type ChatResult = {
  content: string | null;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  meta: CallMeta;
};

export type StructuredRequest = {
  stage: string; // e.g. "report"
  messages: LlmMessage[];
  schemaName: string;
  /** Provider-compatible JSON Schema. Server-side validation happens AFTER, with the full zod schema. */
  schema: JsonSchema;
  maxOutputTokens: number;
  signal?: AbortSignal;
};

export type StructuredResult = {
  /** Parsed JSON (unknown: the caller validates it with zod). */
  value: unknown;
  rawText: string;
  meta: CallMeta;
};

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  structured(req: StructuredRequest): Promise<StructuredResult>;
}
