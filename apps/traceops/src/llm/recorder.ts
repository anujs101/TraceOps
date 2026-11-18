import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LlmCall, type LlmProviderName } from '@traceops/contracts';
import { LlmError, redactSecrets } from './errors.ts';
import type { CallTrace, ChatRequest, ChatResult, LlmProvider, StructuredRequest, StructuredResult } from './types.ts';

/**
 * One record per provider ATTEMPT. Maps 1:1 onto a Contracts v1.1 `llm_calls`
 * row via toLlmCallRow() when the call belongs to an investigation (trace set).
 * Never contains prompts, outputs, headers or credentials.
 */
export type LlmCallRecord = {
  investigationId: string | null;
  turn: number | null;
  attempt: number | null;
  provider: string;
  model: string;
  stage: string;
  kind: 'chat' | 'structured';
  startedAt: string; // IsoUtcMs
  latencyMs: number;
  status: 'ok' | 'error';
  requestId: string | null;
  inputTokens: number | null; // null when the provider reported no usage — never zero-filled
  outputTokens: number | null;
  totalTokens: number | null;
  stopReason: string | null;
  toolCallCount: number | null;
  errorKind: string | null;
  errorStatus: number | null;
  errorMessage: string | null; // redacted, ≤ 300 chars
  retryAfterMs: number | null;
  providerTimings: Record<string, number> | null;
};

export interface CallRecorder {
  record(r: LlmCallRecord): void;
}

export class MemoryRecorder implements CallRecorder {
  readonly records: LlmCallRecord[] = [];
  record(r: LlmCallRecord) { this.records.push(r); }
}

/** JSONL file sink for spikes/dev. */
export class JsonlRecorder implements CallRecorder {
  constructor(private readonly path: string) {}
  record(r: LlmCallRecord) { appendFileSync(this.path, JSON.stringify(r) + '\n'); }
}

/** Decorator: records model, tokens, latency and errors for every attempt of any provider. */
export class RecordingProvider implements LlmProvider {
  private readonly attempts = new Map<string, number>();
  constructor(private readonly inner: LlmProvider, private readonly recorder: CallRecorder, private readonly now: () => number = () => performance.now()) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }

  async chat(req: ChatRequest): Promise<ChatResult> {
    return this.track('chat', req.stage, req.trace, () => this.inner.chat(req), (r) => ({ stopReason: r.stopReason, toolCallCount: r.toolCalls.length }));
  }

  async structured(req: StructuredRequest): Promise<StructuredResult> {
    // a successful structured call always ended normally (truncation throws `truncated`)
    return this.track('structured', req.stage, req.trace, () => this.inner.structured(req), () => ({ stopReason: 'end', toolCallCount: null }));
  }

  private nextAttempt(trace?: CallTrace): number | null {
    if (!trace) return null;
    const k = `${trace.investigationId}:${trace.turn}`;
    const n = (this.attempts.get(k) ?? 0) + 1;
    this.attempts.set(k, n);
    return n;
  }

  private async track<T extends { meta: ChatResult['meta'] }>(kind: 'chat' | 'structured', stage: string, trace: CallTrace | undefined, fn: () => Promise<T>, extra: (r: T) => { stopReason: string | null; toolCallCount: number | null }): Promise<T> {
    const startedAt = new Date().toISOString();
    const t0 = this.now();
    const base = { investigationId: trace?.investigationId ?? null, turn: trace?.turn ?? null, attempt: this.nextAttempt(trace), provider: this.inner.name, model: this.inner.model, stage, kind, startedAt };
    try {
      const r = await fn();
      const u = r.meta.usage;
      this.recorder.record({
        ...base, model: r.meta.model, latencyMs: Math.round(this.now() - t0), status: 'ok', requestId: r.meta.requestId,
        inputTokens: u?.inputTokens ?? null, outputTokens: u?.outputTokens ?? null, totalTokens: u?.totalTokens ?? null,
        ...extra(r), errorKind: null, errorStatus: null, errorMessage: null, retryAfterMs: null, providerTimings: r.meta.providerTimings,
      });
      return r;
    } catch (e) {
      const err = e instanceof LlmError ? e : new LlmError('unknown', e instanceof Error ? e.message : String(e));
      this.recorder.record({
        ...base, latencyMs: Math.round(this.now() - t0), status: 'error', requestId: null,
        inputTokens: null, outputTokens: null, totalTokens: null, stopReason: null, toolCallCount: null,
        errorKind: err.kind, errorStatus: err.status, errorMessage: redactSecrets(err.message).slice(0, 300), retryAfterMs: err.retryAfterMs, providerTimings: null,
      });
      throw err;
    }
  }
}

/** Record → Contracts v1.1 llm_calls row (validated). Throws for records without an investigation trace. */
export function toLlmCallRow(r: LlmCallRecord, id: string = randomUUID()): LlmCall {
  if (r.investigationId === null || r.turn === null || r.attempt === null) throw new Error('llm call has no investigation trace; not persistable');
  return LlmCall.parse({
    id, investigation_id: r.investigationId, turn: r.turn, attempt: r.attempt,
    provider: r.provider as LlmProviderName, model: r.model, stage: r.stage, kind: r.kind, status: r.status,
    request_id: r.requestId, input_tokens: r.inputTokens, output_tokens: r.outputTokens, cache_read_tokens: null,
    latency_ms: r.latencyMs, stop_reason: r.stopReason, tool_call_count: r.toolCallCount,
    error_kind: r.errorKind, error_status: r.errorStatus, error_message: r.errorMessage, retry_after_ms: r.retryAfterMs,
    provider_timings: r.providerTimings, created_at: r.startedAt,
  });
}
