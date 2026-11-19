import type { z } from 'zod';
import { LOG_LINE_KEYS, toIsoUtcMs, type LogLine as LogLineSchema } from '@traceops/contracts';
import type { LokiEntry } from './backend/index.ts';
import { cleanOrNull, cleanString } from './redact.ts';

export type LogLine = z.infer<typeof LogLineSchema>;

const INT = /^-?\d+$/;
const NUM = /^-?\d+(?:\.\d+)?$/;

/**
 * Loki entry → LogLine. Fields are picked by name from the allowlist, never spread, so
 * exception_stacktrace, host_*, process_*, trace_id and friends cannot reach the model or
 * the evidence store. Loki metadata values are strings: status / duration_ms are parsed
 * (unparseable → null). Strings are redacted and truncated to 300 chars.
 */
export function toLogLine(e: LokiEntry): LogLine {
  const m = e.metadata;
  const status = m.status !== undefined && INT.test(m.status.trim()) ? Number(m.status.trim()) : null;
  const dur = m.duration_ms !== undefined && NUM.test(m.duration_ms.trim()) ? Number(m.duration_ms.trim()) : null;
  const line: LogLine = {
    timestamp: toIsoUtcMs(e.tsNs, 'ns'),
    message: cleanString(e.line),
    severity_text: cleanString(m.severity_text ?? m.detected_level ?? 'unknown', 40),
    exception_type: cleanOrNull(m.exception_type),
    exception_message: cleanOrNull(m.exception_message),
    route: cleanOrNull(m.route),
    status: status !== null && Number.isSafeInteger(status) ? status : null,
    duration_ms: dur !== null && Number.isFinite(dur) ? dur : null,
    service_version: cleanOrNull(m.service_version),
  };
  // Cheap invariant: the object we built has exactly the allowlisted keys.
  if (Object.keys(line).join() !== [...LOG_LINE_KEYS].join()) throw new Error('log line keys drifted from the allowlist');
  return line;
}
