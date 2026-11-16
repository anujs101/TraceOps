import { appendFileSync } from 'node:fs';
import { LlmError, redactSecrets } from './errors.ts';
import type { ChatRequest, ChatResult, LlmProvider, StructuredRequest, StructuredResult } from './types.ts';

/**
 * One row per provider attempt. Maps to the `llm_calls` table in Contracts v1
 * (persistence.md) plus status/error fields; see the proposal in the spike notes.
 */
export type LlmCallRecord = {
  provider: string;
  model: string;
  stage: string;
  kind: 'chat' | 'structured';
  startedAt: string; // IsoUtcMs
  latencyMs: number;
  status: 'ok' | 'error';
  requestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  stopReason: string | null;
  toolCallCount: number | null;
  errorKind: string | null;
  errorStatus: number | null;
  errorMessage: string | null; // redacted
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

/** JSONL file sink for spikes/dev. Records contain no prompts, no outputs and no credentials. */
export class JsonlRecorder implements CallRecorder {
  constructor(private readonly path: string) {}
  record(r: LlmCallRecord) { appendFileSync(this.path, JSON.stringify(r) + '\n'); }
}

/** Decorator: records model, tokens, latency and errors for every call of any provider. */
export class RecordingProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider, private readonly recorder: CallRecorder, private readonly now: () => number = () => performance.now()) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }

  async chat(req: ChatRequest): Promise<ChatResult> {
    return this.track('chat', req.stage, () => this.inner.chat(req), (r) => ({ stopReason: r.stopReason, toolCallCount: r.toolCalls.length }));
  }

  async structured(req: StructuredRequest): Promise<StructuredResult> {
    return this.track('structured', req.stage, () => this.inner.structured(req), () => ({ stopReason: null, toolCallCount: null }));
  }

  private async track<T extends { meta: ChatResult['meta'] }>(kind: 'chat' | 'structured', stage: string, fn: () => Promise<T>, extra: (r: T) => { stopReason: string | null; toolCallCount: number | null }): Promise<T> {
    const startedAt = new Date().toISOString();
    const t0 = this.now();
    const base = { provider: this.inner.name, model: this.inner.model, stage, kind, startedAt };
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
