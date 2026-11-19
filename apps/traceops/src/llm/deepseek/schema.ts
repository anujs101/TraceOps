import { structuredOutputProblems } from '@traceops/contracts';
import type { JsonSchema } from '../types.ts';

/**
 * DeepSeek strict-mode compatibility (api-docs.deepseek.com, Tool Calls guide, fetched 2026-11-19):
 *  - every property of every object in `required`, `additionalProperties: false`
 *  - types: object, string, number, integer, boolean, array, enum, anyOf; $ref/$defs
 *  - string: pattern, format (email, hostname, ipv4, ipv6, uuid) — NOT minLength/maxLength
 *  - array: NOT minItems/maxItems
 *
 * Two classes of problem:
 *  - CONSTRAINT keywords DeepSeek doesn't support. They only narrow values; dropping them from the
 *    wire schema keeps the shape identical, and the local zod `Report`/tool-arg validation still
 *    enforces them. `toDeepSeekWireSchema()` strips these.
 *  - STRUCTURAL keywords (oneOf/allOf/not/if-then-else, optional properties, open objects,
 *    unsupported formats). These change meaning, so they are reported, never rewritten.
 */
export const DEEPSEEK_STRIPPABLE = ['minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems'] as const;
const DEEPSEEK_STRUCTURAL = ['oneOf', 'allOf', 'not', 'if', 'then', 'else'] as const;
const DEEPSEEK_FORMATS = new Set(['email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

export type DeepSeekSchemaProblems = { strippable: string[]; structural: string[] };

export function deepseekStrictProblems(schema: JsonSchema): DeepSeekSchemaProblems {
  const strippable: string[] = [];
  const structural: string[] = [];
  const isStrippable = (p: string) => DEEPSEEK_STRIPPABLE.some((k) => p.includes(`unsupported keyword "${k}"`));
  for (const p of structuredOutputProblems(schema)) (isStrippable(p) ? strippable : structural).push(`contracts-check: ${p}`);
  const walk = (n: unknown, path: string): void => {
    if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    for (const k of DEEPSEEK_STRIPPABLE) if (k in o) strippable.push(`deepseek: ${path} uses unsupported constraint "${k}"`);
    for (const k of DEEPSEEK_STRUCTURAL) if (k in o) structural.push(`deepseek: ${path} uses unsupported keyword "${k}"`);
    if (typeof o.format === 'string' && !DEEPSEEK_FORMATS.has(o.format)) structural.push(`deepseek: ${path} uses unsupported format "${o.format}"`);
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'properties' || k === '$defs') && v && typeof v === 'object') {
        for (const [pk, pv] of Object.entries(v)) walk(pv, `${path}.${k}.${pk}`);
      } else walk(v, `${path}.${k}`);
    }
  };
  walk(schema, '$');
  return { strippable: [...new Set(strippable)], structural: [...new Set(structural)] };
}

/**
 * Pure: returns a copy of `schema` with DeepSeek-unsupported CONSTRAINT keywords removed.
 * Property names (keys under `properties` / `$defs`) are never touched, only keywords.
 * Never weakens validation: callers still validate the model's output with the full zod schema.
 */
export function toDeepSeekWireSchema(schema: JsonSchema): JsonSchema {
  const strip = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(strip);
    if (!n || typeof n !== 'object') return n;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if ((DEEPSEEK_STRIPPABLE as readonly string[]).includes(k)) continue;
      if ((k === 'properties' || k === '$defs') && v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strip(pv)]));
      } else out[k] = strip(v);
    }
    return out;
  };
  return strip(schema) as JsonSchema;
}
