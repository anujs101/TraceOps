import { structuredOutputProblems } from '@traceops/contracts';
import type { JsonSchema } from '../types.ts';

/**
 * Groq strict-mode compatibility (docs: console.groq.com/docs/structured-outputs,
 * fetched 2026-11-17):
 *  - every property listed in `required` (optional = union with null)
 *  - `additionalProperties: false` on every object
 *  - documented: string, number, integer, boolean, object, array, enum, anyOf, $defs/$ref
 *  - NOT documented (treated as unsupported until proven): const, format, pattern,
 *    min/maxLength, min/maxItems, oneOf, allOf, not, if/then/else
 * Our ReportApi already satisfies the stricter Claude-oriented check in contracts;
 * this adds the Groq-specific "undocumented keyword" check.
 */
const GROQ_UNDOCUMENTED = ['const', 'format', 'allOf', 'oneOf', 'not', 'pattern', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'default'] as const;

export function groqStrictProblems(schema: JsonSchema): string[] {
  const problems = structuredOutputProblems(schema).map((p) => `contracts-check: ${p}`);
  const walk = (n: unknown, path: string): void => {
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    for (const k of GROQ_UNDOCUMENTED) if (k in o) problems.push(`groq: ${path} uses undocumented keyword "${k}"`);
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'properties' || k === '$defs') && v && typeof v === 'object') {
        for (const [pk, pv] of Object.entries(v)) walk(pv, `${path}.${k}.${pk}`);
      } else walk(v, `${path}.${k}`);
    }
  };
  walk(schema, '$');
  return problems;
}
