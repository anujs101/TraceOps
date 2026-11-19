/**
 * The repair-round message (evidence-and-report.md §4: one repair round with the violation list).
 * Each violation is explained as: what is wrong + where (path and owning id) + the rule.
 * It only tells the model what to fix; our code never rewrites the report.
 */
import type { ValidationResult } from '@traceops/contracts';

type Issue = ValidationResult['violations'][number];

/** The rule behind each validator code, in imperative form (evidence-and-report.md §4). */
export const RULES: Record<string, string> = {
  V0: 'the report must match the schema exactly (required fields, field types, id formats such as obs_1 / hyp_1, at least one citation per observation, summary ≤ 600 characters, unique value keys)',
  V1: 'cite only evidence ids that exist with status "ok", and every values[].evidence_id must also appear in that observation\'s evidence_ids',
  V2: 'each values[] entry must copy the number exactly from the cited evidence field (a stats key shown in the evidence, or "series@<timestamp>")',
  V3: 'every number in prose is a {key} placeholder bound in that observation\'s values; every bound key is used in its statement; a hypothesis may only use placeholders of observations it cites; the summary has no numbers or placeholders',
  V4: 'hypotheses may only cite observation ids that exist in this report',
  V5: '"high" confidence requires supporting observations that cite both a prometheus and a loki evidence row; otherwise use "medium" or "low"',
  V6: 'every timeline event cites at least one evidence id, and its `at` lies inside a queried evidence window',
  V7: 'status "probable_cause" needs at least one hypothesis; status "insufficient_evidence" cannot have a "high" hypothesis',
  V8: 'every recommendation\'s hypothesis_id must be a hypothesis in this report',
};

const at = (x: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[String(k)] : undefined), x);

/** "observations.2.values.1.key" → the id of the owning item (e.g. obs_3), if the candidate has one. */
function owner(candidate: unknown, path: string): string | null {
  const [section, idx] = path.split('.');
  if (!section || idx === undefined || !/^\d+$/.test(idx)) return null;
  const id = at(candidate, [section, Number(idx), 'id']);
  return typeof id === 'string' ? id : null;
}

/** Every place a value key is bound in the candidate report. */
export function keyBindings(candidate: unknown, key: string): Array<{ path: string; observation: string | null }> {
  const obs = at(candidate, ['observations']);
  if (!Array.isArray(obs)) return [];
  const out: Array<{ path: string; observation: string | null }> = [];
  obs.forEach((o, i) => {
    const values = (o as Record<string, unknown>)?.values;
    if (!Array.isArray(values)) return;
    values.forEach((v, j) => {
      if ((v as Record<string, unknown>)?.key === key) out.push({ path: `observations.${i}.values.${j}.key`, observation: typeof (o as any).id === 'string' ? (o as any).id : null });
    });
  });
  return out;
}

/** One actionable line per violation: what + where + rule. */
export function explainViolation(v: Issue, candidate: unknown): string {
  const where = owner(candidate, v.path);
  const loc = `${v.path}${where ? ` (${where})` : ''}`;
  if (v.rule === 'V0' && /value keys must be unique/.test(v.message)) {
    const key = at(candidate, v.path.split('.').map((s) => (/^\d+$/.test(s) ? Number(s) : s)));
    if (typeof key === 'string') {
      const all = keyBindings(candidate, key).map((b) => `${b.path}${b.observation ? ` (${b.observation})` : ''}`);
      const suffix = where ? `${key}_${where.replace(/^obs_/, 'obs')}` : `${key}_2`;
      return [
        `- [V0] duplicate value key "${key}" at ${loc}; it is bound ${all.length} times: ${all.join(', ')}.`,
        `  Rule: every {key} must be unique across the whole report. Give each binding its own key name (e.g. rename this one to "${suffix}") and change the matching {${key}} placeholder in that observation's statement to the new name.`,
      ].join('\n');
    }
  }
  const rule = RULES[v.rule];
  return `- [${v.rule}] ${loc}: ${v.message}.${rule ? `\n  Rule: ${rule}.` : ''}`;
}

export function repairPrompt(v: ValidationResult, candidate?: unknown): string {
  return [
    'Your report failed server-side validation. Return the COMPLETE corrected report as JSON matching the same schema.',
    'Fix every violation below and change nothing that is not needed. Each line says what is wrong, where, and the rule:',
    ...v.violations.slice(0, 30).map((x) => explainViolation(x, candidate)),
    ...(v.violations.length > 30 ? [`(${v.violations.length - 30} more violations of the same kinds; fix them the same way.)`] : []),
  ].join('\n');
}
