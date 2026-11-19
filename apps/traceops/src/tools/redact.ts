import { LIMITS } from '@traceops/contracts';

/**
 * Redaction and truncation for every string that reaches the model or the evidence
 * store (tools.md §4). Order matters: connection strings first, then labelled secrets,
 * then free-standing tokens, then long opaque blobs.
 */
const RULES: [RegExp, string][] = [
  // any scheme://user:pass@host  → scheme://[REDACTED]@host (http, ftp, jdbc:…, db and queue schemes alike)
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s:@\/]+:[^\s@\/]+@/gi, '$1[REDACTED]@'],
  // Authorization: Bearer <token> / Basic <token>
  [/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer [REDACTED]'],
  // Basic only when the token looks like base64 credentials (digit or =+/), so "Basic validation" survives
  [/\bBasic\s+(?=[A-Za-z0-9+\/=]*[\d=+\/])[A-Za-z0-9+\/]{8,}={0,2}/gi, 'Basic [REDACTED]'],
  // labelled secrets: api_key=…, "token": "…", password: …
  [/\b((?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|auth[_-]?token|token|passw(?:or)?d|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[REDACTED]'],
  // well-known provider key shapes
  [/\b(?:gsk|sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_A-Za-z0-9]{16,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[REDACTED]'],
  // emails
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[EMAIL]'],
  // long hex runs (hashes, trace ids, keys). UUIDs have dashes, so they stay.
  [/\b[0-9a-fA-F]{32,}\b/g, '[HEX]'],
  // long base64-ish blobs; must mix upper, lower and digits so words and long URL paths survive
  [/(?<![A-Za-z0-9+\/=_-])(?=[A-Za-z0-9+\/_]*[A-Z])(?=[A-Za-z0-9+\/_]*[a-z])(?=[A-Za-z0-9+\/_]*\d)[A-Za-z0-9+\/_]{40,}={0,2}(?![A-Za-z0-9+\/=_-])/g, '[BLOB]'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}

export function truncate(s: string, max: number = LIMITS.logStringMaxChars): string {
  if (s.length <= max) return s;
  // never split a surrogate pair
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/** Redact, then truncate: a secret cut in half must not survive as a prefix. */
export function cleanString(s: string, max: number = LIMITS.logStringMaxChars): string {
  return truncate(redact(s), max);
}

export function cleanOrNull(s: string | null | undefined): string | null {
  if (s == null || s === '') return null;
  return cleanString(s);
}
