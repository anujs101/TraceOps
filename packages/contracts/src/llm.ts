import { z } from 'zod';
import { IsoUtcMs } from './time.ts';

/**
 * Contracts v1.1 — provider-neutral LLM contract (persistence.md §1 `llm_calls`,
 * environment.md §4). Single source for provider names, error taxonomy and the
 * llm_calls row shape. Adapters (apps/traceops/src/llm/<provider>/) must map onto it.
 */
export const LLM_PROVIDERS = ['groq'] as const; // implemented providers; others are added with their adapter
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LLM_DEFAULTS = {
  provider: 'groq',
  groq: {
    model: 'openai/gpt-oss-20b', // verified: every live Groq response (2026-11-16/17) reported this id
    baseUrl: 'https://api.groq.com', // groq-sdk appends /openai/v1/...; do NOT include it here
    timeoutMs: 30_000,
  },
} as const;

export const LLM_STAGES = ['investigate', 'report'] as const;
export const LLM_CALL_KINDS = ['chat', 'structured'] as const;
export const LLM_STOP_REASONS = ['tool_calls', 'end', 'length', 'other'] as const;

/** Error taxonomy every adapter maps provider errors into. */
export const LLM_ERROR_KINDS = [
  'auth', // 401/403 — never retried
  'rate_limit', // 429 — retried after retry_after_ms
  'capacity', // provider capacity (Groq 498), 503 — retried
  'server', // other 5xx — retried
  'timeout', // client timeout — retried
  'connection', // network — retried
  'invalid_generation', // provider rejected the MODEL's output (Groq 400 tool_use_failed / json_validate_failed) — re-sampled
  'bad_request', // other 4xx — not retried
  'malformed_response', // response missing fields / not JSON — not retried
  'truncated', // stopped at max tokens — not retried
  'schema_violation', // valid JSON failing our zod validation — handled by report repair, not retried
  'aborted',
  'unknown',
] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];
export const RETRYABLE_LLM_ERRORS: readonly LlmErrorKind[] = ['rate_limit', 'capacity', 'server', 'timeout', 'connection', 'invalid_generation'];

const nonNegInt = z.number().int().nonnegative();

/**
 * One row per provider ATTEMPT (retries are separate rows), keyed by
 * (investigation_id, turn, attempt). Never contains prompts, outputs, headers or keys.
 * Token counts are NULL when the provider reported no usage (errors, or a
 * response without usage) — never zero-filled.
 */
export const LlmCall = z.object({
  id: z.uuid(),
  investigation_id: z.uuid(),
  turn: z.number().int().min(1), // logical model request within the investigation (investigate turns, then report turns)
  attempt: z.number().int().min(1), // 1 = first try; retries increment
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().min(1), // as reported by the provider (fallback: configured model)
  stage: z.enum(LLM_STAGES),
  kind: z.enum(LLM_CALL_KINDS),
  status: z.enum(['ok', 'error']),
  request_id: z.string().nullable(),
  input_tokens: nonNegInt.nullable(),
  output_tokens: nonNegInt.nullable(),
  cache_read_tokens: nonNegInt.nullable(), // v1 column kept; NULL for providers that don't report it (Groq)
  latency_ms: nonNegInt,
  stop_reason: z.enum(LLM_STOP_REASONS).nullable(),
  tool_call_count: nonNegInt.nullable(),
  error_kind: z.enum(LLM_ERROR_KINDS).nullable(),
  error_status: z.number().int().nullable(),
  error_message: z.string().max(300).nullable(), // redacted
  retry_after_ms: nonNegInt.nullable(),
  provider_timings: z.record(z.string(), z.number()).nullable(),
  created_at: IsoUtcMs, // when the attempt started
}).strict().superRefine((r, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (r.status === 'ok') {
    if (r.error_kind !== null || r.error_status !== null || r.error_message !== null) bad('error_kind', 'ok rows carry no error fields');
    if (r.stop_reason === null) bad('stop_reason', 'ok rows need a stop_reason');
  } else {
    if (r.error_kind === null) bad('error_kind', 'error rows need an error_kind');
    if (r.input_tokens !== null || r.output_tokens !== null) bad('input_tokens', 'error rows carry no token usage');
  }
  if (r.kind === 'structured' && r.tool_call_count !== null) bad('tool_call_count', 'structured calls have no tool calls');
});
export type LlmCall = z.infer<typeof LlmCall>;
