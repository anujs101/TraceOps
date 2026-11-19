/**
 * The repair-round message (evidence-and-report.md §4: one repair round with the violation list).
 * Each violation is explained as: what is wrong + where (path and owning id) + the rule.
 * It only tells the model what to fix; our code never rewrites the report.
 */
import type { Evidence, ValidationResult } from '@traceops/contracts';

type Issue = ValidationResult['violations'][number];

/** The rule behind each validator code, in imperative form (evidence-and-report.md §4). */
export const RULES: Record<string, string> = {
  V0: 'the report must match the schema exactly (required fields, field types, id formats such as obs_1 / hyp_1, at least one citation per observation, summary ≤ 600 characters, unique value keys)',
  V1: 'cite only evidence ids that exist with status "ok", and every values[].evidence_id must also appear in that observation\'s evidence_ids; results with status empty, error or budget_exhausted are never cited in observations or the timeline, only named in gaps',
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

/** Value keys bound in each observation, by observation id. */
function keysByObservation(candidate: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const obs = at(candidate, ['observations']);
  if (!Array.isArray(obs)) return out;
  for (const o of obs as Array<Record<string, unknown>>) {
    if (typeof o?.id !== 'string') continue;
    const keys = Array.isArray(o.values) ? (o.values as Array<Record<string, unknown>>).map((x) => x?.key).filter((k): k is string => typeof k === 'string') : [];
    out.set(o.id, keys);
  }
  return out;
}

/** The observation ids a hypothesis cites (supporting + contradicting). */
function citedObservations(candidate: unknown, path: string): string[] {
  const [section, idx] = path.split('.');
  if (section !== 'hypotheses' || idx === undefined) return [];
  const h = at(candidate, [section, Number(idx)]) as Record<string, unknown> | undefined;
  const ids = [...(Array.isArray(h?.supporting_observation_ids) ? h!.supporting_observation_ids : []), ...(Array.isArray(h?.contradicting_observation_ids) ? h!.contradicting_observation_ids : [])];
  return [...new Set(ids.filter((x): x is string => typeof x === 'string'))];
}

/** Specific instruction for V1 / V3 violations (incl. unbound quantities) (what to do, not only what is wrong). */
function fixHint(v: Issue, candidate: unknown, where: string | null, evidence?: Evidence[]): string | null {
  if (v.rule === 'V1') {
    const m = /^(ev_\w+) is unknown or not status ok$/.exec(v.message);
    if (!m) return null;
    const id = m[1]!;
    const row = evidence?.find((e) => e.id === id);
    const what = evidence ? (row ? `${id} has status "${row.status}"` : `${id} does not exist in the evidence list`) : `${id} is not an ok evidence row`;
    const section = v.path.split('.')[0];
    if (section === 'timeline') return `  Fix: ${what}. Remove ${id} from this event's evidence_ids; if no ok evidence id is left, delete the event. Mention the call in gaps instead (plain text with its id).`;
    return [
      `  Fix: ${what}. Remove ${id} from this observation's evidence_ids (and any values entry that uses it).`,
      `  If no evidence id with status "ok" is left, delete the observation${where ? ` ${where}` : ''} entirely, remove ${where ?? 'its id'} from every hypothesis's supporting/contradicting ids, and instead write a gap that names the call by id (e.g. "<tool> over <window> returned ${row?.status ?? 'empty'} (${id})"). Results that are not "ok" belong only in gaps.`,
    ].join('\n');
  }
  if (v.rule === 'V3') {
    const q = /^unbound quantity "([^"]+)"/.exec(v.message);
    if (q) {
      const tok = q[1]!;
      const approx = /^[~≈]/.test(tok) ? ` Approximate numbers ("~", "about", "≈") are quantities too.` : '';
      const section = v.path.split('.')[0];
      if (section === 'observations') {
        return `  Fix: "${tok}" is a number written as text.${approx} Add a values entry {key, evidence_id, field, value} copied exactly from one of this observation's cited ok evidence rows and replace "${tok}" with {key}; if no cited evidence field holds that number, delete it from the sentence.`;
      }
      if (section === 'timeline') {
        return `  Fix: "${tok}" is a number written as text.${approx} Timeline events cannot bind values, so they cannot contain numbers: remove "${tok}" from this event and describe the change in words (e.g. "rose", "reached its maximum"). Put the number in an observation instead, as a {key} placeholder bound in its values.`;
      }
      if (section === 'hypotheses') {
        const byObs = keysByObservation(candidate);
        const usable = citedObservations(candidate, v.path).map((o) => `${o}: ${(byObs.get(o) ?? []).join(', ') || '(no keys)'}`).join('; ');
        return `  Fix: "${tok}" is a number written as text.${approx} Hypotheses have no values of their own: replace "${tok}" with a {key} already bound in an observation this hypothesis cites${usable ? ` (available: ${usable})` : ''}, or rewrite the sentence without that number.`;
      }
      if (section === 'summary') {
        return `  Fix: the summary must contain no numbers at all. Remove "${tok}" and describe it in words; the numbers belong in observations.`;
      }
    }
  }
  if (v.rule === 'V3' && v.path.startsWith('hypotheses.')) {
    const missing = /^placeholder \{([^}]+)\} has no value$/.exec(v.message);
    const notCited = /^placeholder \{([^}]+)\} belongs to (\S+), which this hypothesis does not cite$/.exec(v.message);
    const byObs = keysByObservation(candidate);
    const cited = citedObservations(candidate, v.path);
    const usable = cited.map((o) => `${o}: ${(byObs.get(o) ?? []).join(', ') || '(no keys)'}`).join('; ');
    if (missing) {
      return [
        `  Fix: {${missing[1]}} is not bound anywhere. Hypotheses have no values of their own; never add values to a hypothesis or invent a new key.`,
        `  Replace {${missing[1]}} with a key already bound in an observation this hypothesis cites, spelled exactly${usable ? ` (available: ${usable})` : ''}, or rewrite the sentence without that number.`,
      ].join('\n');
    }
    if (notCited) {
      return `  Fix: {${notCited[1]}} is bound in ${notCited[2]}. Either add ${notCited[2]} to this hypothesis's supporting or contradicting ids (only if it really bears on it), or use a key from an observation it already cites${usable ? ` (available: ${usable})` : ''}, or drop the number.`;
    }
  }
  if (v.rule === 'V3' && v.path.startsWith('observations.')) {
    const missing = /^placeholder \{([^}]+)\} has no value$/.exec(v.message);
    if (missing) return `  Fix: add a values entry {key:"${missing[1]}", evidence_id, field, value} to this observation, copied from one of its cited ok evidence rows, or remove {${missing[1]}} from the statement.`;
    const unused = /^value key "([^"]+)" is not used in the statement$/.exec(v.message);
    if (unused) return `  Fix: write {${unused[1]}} into this observation's statement where that number belongs, or delete the values entry with key "${unused[1]}".`;
  }
  return null;
}

/** One actionable line per violation: what + where + rule (+ how to fix, where we can say). */
export function explainViolation(v: Issue, candidate: unknown, evidence?: Evidence[]): string {
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
  const hint = fixHint(v, candidate, where, evidence);
  return `- [${v.rule}] ${loc}: ${v.message}.${rule ? `\n  Rule: ${rule}.` : ''}${hint ? `\n${hint}` : ''}`;
}

export function repairPrompt(v: ValidationResult, candidate?: unknown, evidence?: Evidence[]): string {
  return [
    'Your report failed server-side validation. Return the COMPLETE corrected report as JSON matching the same schema.',
    'Fix every violation below and change nothing that is not needed. Each line says what is wrong, where, and the rule:',
    ...v.violations.slice(0, 30).map((x) => explainViolation(x, candidate, evidence)),
    ...(v.violations.length > 30 ? [`(${v.violations.length - 30} more violations of the same kinds; fix them the same way.)`] : []),
  ].join('\n');
}
