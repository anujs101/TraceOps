import type { BackendResult } from './backend/index.ts';
import { cleanString } from './redact.ts';

/**
 * Backend errors can carry PromQL/LogQL fragments, hostnames and URLs. The model and
 * the evidence row therefore never see backend error text: `error` is built from the
 * failure kind and, for backend errors, a validated machine code only.
 */
type Failure = Extract<BackendResult<unknown>, { ok: false }>;

const MAX = 300;

export function sanitizeBackendError(source: 'prometheus' | 'loki', f: Failure): string {
  switch (f.kind) {
    case 'timeout': return `backend_error: ${source} timed out`;
    case 'network': return `backend_error: ${source} unreachable`;
    case 'aborted': return 'aborted';
    case 'http': return `backend_error: ${source} returned a non-JSON response`;
    case 'parse': return `backend_error: ${source} returned an unexpected response`;
    case 'backend': {
      // message is "<source> <errorType>: <text>"; keep only a bare machine code like bad_data
      const code = /^(?:prometheus|loki) ([a-z_]{1,30}):/.exec(f.message)?.[1];
      return `backend_error: ${source} rejected the query${code ? ` (${code})` : ''}`;
    }
  }
}

/** `invalid_input: <reason>`, redacted and capped so it fits Evidence.error (≤ 300). */
export function invalidInput(reason: string): string {
  return cleanString(`invalid_input: ${reason}`, MAX);
}
