import { describe, expect, it } from 'vitest';
import { explainViolation, keyBindings, repairPrompt, RULES } from '../../src/report/repair-prompt.ts';
import { validateReport } from '../../src/report/validator.ts';
import { evidence, firstLiveReport, repairedReport } from '../fixtures/first-live-report.ts';

/** The live S1 failure (2026-11-19): one key bound in two observations. */
function withDuplicateKey() {
  const r = structuredClone(repairedReport) as any;
  const [a, b] = r.observations;
  const dupKey = a.values[0].key;
  b.values[0] = { ...b.values[0], key: dupKey };
  b.statement = b.statement.replace(/\{[a-z0-9_]+\}/, `{${dupKey}}`);
  return { r, dupKey, aId: a.id, bId: b.id };
}

describe('repair prompt: actionable violations', () => {
  it('V0 duplicate key: names the key, every location, the rule and a concrete rename', () => {
    const { r, dupKey, aId, bId } = withDuplicateKey();
    const v = validateReport(r, evidence);
    const dup = v.violations.find((x) => x.rule === 'V0' && /unique/.test(x.message));
    expect(dup).toBeDefined();
    const line = explainViolation(dup!, r);
    expect(line).toContain(`duplicate value key "${dupKey}"`);
    expect(line).toContain(`observations.0.values.0.key (${aId})`);
    expect(line).toContain(`observations.1.values.0.key (${bId})`);
    expect(line).toContain('every {key} must be unique across the whole report');
    expect(line).toContain(`"${dupKey}_${bId.replace('obs_', 'obs')}"`);
    expect(keyBindings(r, dupKey)).toHaveLength(2);
  });

  it('every V-rule has a rule text, and each line says what + where + rule', () => {
    for (const k of ['V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']) expect(RULES[k]).toBeTruthy();
    const v = validateReport(firstLiveReport, evidence);
    expect(v.violations.length).toBeGreaterThan(0);
    const text = repairPrompt(v, firstLiveReport);
    for (const x of v.violations) {
      expect(text).toContain(`[${x.rule}] ${x.path}`);
      expect(text).toContain(x.message);
      expect(text).toContain(`Rule: ${RULES[x.rule]}`);
    }
  });

  it('the prompt asks the model for the complete corrected report; it never contains a rewritten report', () => {
    const { r } = withDuplicateKey();
    const text = repairPrompt(validateReport(r, evidence), r);
    expect(text).toMatch(/Return the COMPLETE corrected report/);
    expect(text).not.toContain(JSON.stringify(r).slice(0, 40));
  });

  it('works without the candidate (no ids known) and caps at 30 lines', () => {
    const many = { passed: false, warnings: [], violations: Array.from({ length: 35 }, (_, i) => ({ rule: 'V1', path: `observations.${i}.evidence_ids`, message: `ev_${i + 99} is unknown or not status ok` })) };
    const text = repairPrompt(many);
    expect(text.match(/^- \[V1\]/gm)).toHaveLength(30);
    expect(text).toContain('(5 more violations');
  });
});
