import { RETRYABLE_LLM_ERRORS, type LlmErrorKind } from '@traceops/contracts';

/** Provider-neutral error taxonomy: defined once in Contracts v1.1 (packages/contracts/src/llm.ts). */
export type { LlmErrorKind };

const RETRYABLE: ReadonlySet<LlmErrorKind> = new Set(RETRYABLE_LLM_ERRORS);

export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly providerCode: string | null;
  readonly details: unknown;

  constructor(kind: LlmErrorKind, message: string, opts: { status?: number | null; retryAfterMs?: number | null; providerCode?: string | null; details?: unknown } = {}) {
    super(redactSecrets(message));
    this.name = 'LlmError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.providerCode = opts.providerCode ?? null;
    this.details = opts.details;
  }

  toJSON() {
    return { kind: this.kind, message: this.message, status: this.status, retryable: this.retryable, retryAfterMs: this.retryAfterMs, providerCode: this.providerCode };
  }
}

/** Defence in depth: strip anything that looks like an API key from text we log or store. */
export function redactSecrets(text: string): string {
  return text
    .replace(/gsk_[A-Za-z0-9]{8,}/g, 'gsk_[REDACTED]')
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]')
    .replace(/(authorization|x-api-key)\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [REDACTED]');
}
