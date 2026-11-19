import { describe, expect, it } from 'vitest';
import { explainViolation, keyBindings, repairPrompt, RULES } from '../../src/report/repair-prompt.ts';
import { validateReport } from '../../src/report/validator.ts';
import { evidence, firstLiveReport, repairedReport } from '../fixtures/first-live-report.ts';
import { s2Evidence, s2Report } from '../fixtures/s2-live-run.ts';

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

describe('repair prompt: actionable V1/V3 (live S2 run 1, 2026-11-19)', () => {
  const v = validateReport(s2Report, s2Evidence);
  const text = repairPrompt(v, s2Report, s2Evidence);

  it('the fixture reproduces the live failure: 7×V1 + 6×V3', () => {
    expect(v.violations.filter((x) => x.rule === 'V1')).toHaveLength(7);
    expect(v.violations.filter((x) => x.rule === 'V3')).toHaveLength(6);
    expect(v.violations).toHaveLength(13);
  });

  it('V1 names the real status of each cited row and says to move it to gaps', () => {
    expect(text).toContain('ev_7 has status "empty"');
    expect(text).toContain('ev_8 has status "error"');
    expect(text).toContain('ev_13 has status "budget_exhausted"');
    const v1 = v.violations.filter((x) => x.rule === 'V1').map((x) => explainViolation(x, s2Report, s2Evidence));
    for (const line of v1) {
      expect(line).toMatch(/Remove ev_\d+ from this observation's evidence_ids/);
      expect(line).toMatch(/delete the observation obs_\d+ entirely/);
      expect(line).toMatch(/write a gap that names the call by id/);
    }
  });

  it('V1 for an id that does not exist says so', () => {
    const line = explainViolation({ rule: 'V1', path: 'observations.0.evidence_ids', message: 'ev_99 is unknown or not status ok' }, s2Report, s2Evidence);
    expect(line).toContain('ev_99 does not exist in the evidence list');
  });

  it('V3 on a hypothesis lists the keys of the observations it cites and says to reuse them', () => {
    const db = v.violations.find((x) => x.message.includes('{db_hmax}'))!;
    const line = explainViolation(db, s2Report, s2Evidence);
    expect(line).toContain('hypotheses.0.statement (hyp_1)');
    expect(line).toContain('obs_4: db_first, db_max, db_mid');
    expect(line).toContain('obs_1: lat_base, lat_base_avg, lat_max');
    expect(line).toMatch(/never add values to a hypothesis or invent a new key/);
    expect(line).toMatch(/Replace \{db_hmax\} with a key already bound/);
  });

  it('V3 "belongs to an uncited observation" says: cite it or use a cited key', () => {
    const r = structuredClone(s2Report) as any;
    r.hypotheses[3].statement = 'A traffic surge drove latency to {lat_max}.'; // hyp_4 now cites only obs_3
    r.hypotheses[3].supporting_observation_ids = ['obs_3'];
    r.hypotheses[3].contradicting_observation_ids = [];
    const x = validateReport(r, s2Evidence).violations.find((y) => /belongs to obs_1/.test(y.message))!;
    const line = explainViolation(x, r, s2Evidence);
    expect(line).toContain('{lat_max} is bound in obs_1');
    expect(line).toContain('add obs_1 to this hypothesis\'s supporting or contradicting ids');
    expect(line).toContain('obs_3: req_min, req_max');
  });

  it('V3 on an observation: add the binding or remove the placeholder / unused key', () => {
    const missing = explainViolation({ rule: 'V3', path: 'observations.0.statement', message: 'placeholder {foo} has no value' }, s2Report, s2Evidence);
    expect(missing).toContain('add a values entry {key:"foo", evidence_id, field, value}');
    const unused = explainViolation({ rule: 'V3', path: 'observations.0.values', message: 'value key "foo" is not used in the statement' }, s2Report, s2Evidence);
    expect(unused).toContain('write {foo} into this observation\'s statement');
  });

  it('still works without evidence (no status known)', () => {
    const line = explainViolation(v.violations[0]!, s2Report);
    expect(line).toContain('ev_7 is not an ok evidence row');
    expect(line).toContain('Rule: ');
  });
});
