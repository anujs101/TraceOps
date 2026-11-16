/**
 * Numeric-grounding contract (evidence-and-report.md §3, rules V2/V3).
 *
 * Design goal: catch invented QUANTITIES without rejecting technical vocabulary.
 * - Quantities in prose are written as `{key}` placeholders bound to values.
 * - Only tokens that read as quantities are checked: bare numbers ("10", "0.47",
 *   "31%") and unit-suffixed numbers ("2s", "500ms", "3x").
 * - Identifiers are never quantities: p95, 5xx, v1.0.1, ev_3, /orders,
 *   db_client_connection_count, http_response_status_code, HTTP/1.1.
 * - Bare integers that appear in the evidence as identifiers (HTTP status codes,
 *   service versions) are allowed via a context allowlist, so "HTTP 500" passes
 *   when a 500 exists in the evidence.
 * - Clock times (18:03, ISO timestamps) are not quantities; they produce a
 *   warning because times belong in the timeline.
 */
export type TokenClass = 'placeholder' | 'identifier' | 'quantity' | 'time' | 'word';

const UNIT_QUANTITY = /^[-+]?\d+(?:\.\d+)?(?:ms|s|sec|secs|m|min|mins|h|%|x|rps|qps|k|kb|mb|gb)$/i;
const BARE_NUMBER = /^[-+]?\d+(?:\.\d+)?%?$/;
const STATUS_FAMILY = /^[1-5]xx$/i;
const PERCENTILE = /^p\d{1,3}(?:\.\d+)?$/i;
const SEMVER = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/i;
const CLOCK = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
const PLACEHOLDER = /^\{[a-z][a-z0-9_]*\}$/;

export function classifyToken(raw: string): { token: string; cls: TokenClass } {
  // strip wrapping punctuation but keep internal . / _ : -
  const token = raw.replace(/^[("'`[]+/, '').replace(/[)"'`\],;!?]+$/, '').replace(/[.:]+$/, '');
  if (token === '') return { token, cls: 'word' };
  if (PLACEHOLDER.test(token)) return { token, cls: 'placeholder' };
  if (CLOCK.test(token) || ISO.test(token)) return { token, cls: 'time' };
  if (SEMVER.test(token) || STATUS_FAMILY.test(token) || PERCENTILE.test(token)) return { token, cls: 'identifier' };
  if (UNIT_QUANTITY.test(token)) return { token, cls: 'quantity' };
  if (BARE_NUMBER.test(token)) return { token, cls: 'quantity' };
  if (/\d/.test(token) && /[A-Za-z_/]/.test(token)) return { token, cls: 'identifier' };
  if (/\d/.test(token)) return { token, cls: 'quantity' }; // e.g. "1,000", "10-20"
  return { token, cls: 'word' };
}

export type QuantityFinding = { token: string; kind: 'unbound_quantity' | 'time_literal' };

/**
 * Returns quantities not written as placeholders. `allowedLiterals` comes from the
 * evidence context (status codes, service versions seen in evidence results).
 */
export function findUnboundQuantities(text: string, allowedLiterals: Iterable<string> = []): QuantityFinding[] {
  const allowed = new Set(allowedLiterals);
  const out: QuantityFinding[] = [];
  for (const raw of text.split(/\s+/)) {
    // "{a}/{b}" or "{a}-{b}" compound: split on separators between placeholders
    for (const part of raw.split(/(?<=\})[/-](?=\{)/)) {
      const { token, cls } = classifyToken(part);
      if (cls === 'quantity' && !allowed.has(token)) out.push({ token, kind: 'unbound_quantity' });
      if (cls === 'time') out.push({ token, kind: 'time_literal' });
    }
  }
  return out;
}

export function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]!);
}

/**
 * A claimed value matches an evidence value if it equals it, or equals it rounded
 * to 1–6 significant figures (honest rounding: 0.4684 → 0.47 or 0.5; 31 → 30).
 * Values are always in the evidence's unit (ratio, not percent).
 */
export function valueMatches(claimed: number, actual: number): boolean {
  if (!Number.isFinite(claimed) || !Number.isFinite(actual)) return false;
  const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  if (eq(claimed, actual)) return true;
  for (let k = 1; k <= 6; k++) if (eq(claimed, Number(actual.toPrecision(k)))) return true;
  return false;
}
