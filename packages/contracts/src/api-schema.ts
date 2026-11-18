import { z } from 'zod';

/**
 * Offline, provider-neutral compatibility check: the conservative intersection
 * of documented strict-schema limits (originally Claude's; Groq's strict mode
 * is checked additionally by the Groq adapter's groqStrictProblems()):
 * supported: object/array/string/integer/number/boolean/null, enum, const,
 * anyOf, allOf, $ref/$defs, listed string formats, additionalProperties:false.
 * NOT supported: recursive schemas, numeric constraints, string length
 * constraints, complex array constraints, additionalProperties other than false.
 * Live-verified with Groq (openai/gpt-oss-20b, strict) on 2026-11-17.
 */
const UNSUPPORTED_KEYWORDS = [
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'pattern',
  'minItems', 'maxItems', 'uniqueItems', 'contains', 'prefixItems',
  'patternProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'if', 'then', 'else', 'not', 'oneOf', 'dependentSchemas', 'dependentRequired',
] as const;
const SUPPORTED_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']);

export function toApiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'throw' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function structuredOutputProblems(node: unknown, path = '$', seenRefs = new Set<string>()): string[] {
  const problems: string[] = [];
  if (Array.isArray(node)) { node.forEach((n, i) => problems.push(...structuredOutputProblems(n, `${path}[${i}]`, seenRefs))); return problems; }
  if (!node || typeof node !== 'object') return problems;
  const n = node as Record<string, unknown>;
  for (const k of UNSUPPORTED_KEYWORDS) if (k in n) problems.push(`${path}: unsupported keyword "${k}"`);
  if (typeof n.format === 'string' && !SUPPORTED_FORMATS.has(n.format)) problems.push(`${path}: unsupported format "${n.format}"`);
  if (n.type === 'object' || 'properties' in n) {
    if (n.additionalProperties !== false) problems.push(`${path}: object must set additionalProperties:false`);
    const props = Object.keys((n.properties as object) ?? {});
    const req = new Set((n.required as string[]) ?? []);
    const missing = props.filter((p) => !req.has(p));
    if (missing.length) problems.push(`${path}: optional properties not allowed in our contract (${missing.join(', ')}); use nullable`);
  }
  if (typeof n.$ref === 'string') {
    if (seenRefs.has(n.$ref)) problems.push(`${path}: recursive $ref ${n.$ref}`);
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === '$ref') continue;
    if ((k === 'properties' || k === '$defs') && v && typeof v === 'object') {
      // keys here are property names, not keywords: recurse into each value only
      for (const [pk, pv] of Object.entries(v)) problems.push(...structuredOutputProblems(pv, `${path}.${k}.${pk}`, seenRefs));
      continue;
    }
    problems.push(...structuredOutputProblems(v, `${path}.${k}`, seenRefs));
  }
  return problems;
}
