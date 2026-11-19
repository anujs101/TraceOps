import { describe, expect, it } from 'vitest';
import { GroqProvider } from '../../src/llm/groq/adapter.ts';
import { MemoryRecorder, RecordingProvider } from '../../src/llm/recorder.ts';
import type { LlmProvider } from '../../src/llm/types.ts';
import { generateValidatedReport, MAX_REPAIR_ROUNDS, type ReportRow } from '../../src/report/generate.ts';
import { validateReport } from '../../src/report/validator.ts';
import { FakeGroqClient, textResponse } from '../llm/fakes.ts';
import { evidence, firstLiveReport, repairedReport } from '../fixtures/first-live-report.ts';

const sinkOf = () => { const rows: ReportRow[] = []; return { rows, sink: { save: async (r: ReportRow) => { rows.push(r); } } }; };
const providerWith = (...outputs: unknown[]) => {
  const client = new FakeGroqClient(outputs.map((o) => textResponse(typeof o === 'string' ? o : JSON.stringify(o))));
  const rec = new MemoryRecorder();
  return { client, rec, provider: new RecordingProvider(new GroqProvider(client, { model: 'm', reasoningEffort: null }), rec) };
};
const run = (provider: LlmProvider, sink: { save: (r: ReportRow) => Promise<void> }) =>
  generateValidatedReport(provider, [{ role: 'user', content: 'write the report' }], evidence, { investigationId: 'inv-1', sink, maxOutputTokens: 100 });

describe('validator on the first live report', () => {
  it('finds exactly the 5 unbound quantities and the unsupported high-confidence hypothesis', () => {
    const v = validateReport(firstLiveReport, evidence);
    expect(v.passed).toBe(false);
    const v3 = v.violations.filter((x) => x.rule === 'V3');
    // the 5 inline numbers seen live…
    expect(v3.filter((x) => x.message.startsWith('unbound quantity')).map((x) => x.message.match(/"(.+?)"/)?.[1])).toEqual(['10', '10', '0.347', '0.0939', '100']);
    // …and, under the full V3 rule (the live smoke only checked a subset), the 5 bound values left unused
    expect(v3.filter((x) => x.message.includes('is not used')).map((x) => x.message.match(/"(.+?)"/)?.[1])).toEqual(['pool_used_max', 'pool_max_value', 'el_max', 'el_avg', 'timeout_logs']);
    expect(v3).toHaveLength(10);
    expect(v.violations.filter((x) => x.rule === 'V5')).toEqual([{ rule: 'V5', path: 'hypotheses.1.confidence', message: expect.stringContaining('high confidence requires') }]);
    expect(v.violations.filter((x) => !['V3', 'V5'].includes(x.rule))).toEqual([]); // values themselves are grounded (V2 clean)
  });

  it('passes the correctly repaired report', () => {
    expect(validateReport(repairedReport, evidence)).toMatchObject({ passed: true, violations: [] });
  });
});

describe('repair flow', () => {
  it('one repair round fixes it: full validator re-runs, row stored as passed', async () => {
    const { rows, sink } = sinkOf();
    const { client, rec, provider } = providerWith(firstLiveReport, repairedReport);
    const out = await run(provider, sink);
    expect(out.attempts.map((a) => a.validation.passed)).toEqual([false, true]);
    expect(rows).toEqual([expect.objectContaining({ investigation_id: 'inv-1', validation: 'passed', violations: [], repair_attempted: true, report: repairedReport })]);
    // the repair request carries the previous output and the violation list
    const repairMsgs = client.bodies[1]!.messages as Array<{ role: string; content: string }>;
    expect(repairMsgs.at(-2)!.role).toBe('assistant');
    // each violation: what + where (path and owning id) + the rule
    expect(repairMsgs.at(-1)!.content).toMatch(/\[V3\] observations\.0\.statement \(obs_\d+\): unbound quantity "10"/);
    expect(repairMsgs.at(-1)!.content).toMatch(/\[V5\] hypotheses\.1\.confidence \(hyp_\d+\)/);
    expect(repairMsgs.at(-1)!.content).toContain('Rule: "high" confidence requires supporting observations that cite both a prometheus and a loki evidence row');
    expect(rec.records.map((r) => r.stage)).toEqual(['report', 'report']);
  });

  it('is bounded: after one failed repair the report is stored as UNVALIDATED with its violations', async () => {
    const { rows, sink } = sinkOf();
    const { client, provider } = providerWith(firstLiveReport, firstLiveReport, repairedReport /* never requested */);
    const out = await run(provider, sink);
    expect(MAX_REPAIR_ROUNDS).toBe(1);
    expect(client.bodies).toHaveLength(2); // initial + exactly one repair
    expect(out.attempts).toHaveLength(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ validation: 'failed', repair_attempted: true, report: firstLiveReport });
    expect(rows[0]!.violations.map((v) => v.rule).sort()).toEqual([...Array(10).fill('V3'), 'V5']);
  });

  it('a valid first report is stored without a repair round', async () => {
    const { rows, sink } = sinkOf();
    const { client, provider } = providerWith(repairedReport);
    await run(provider, sink);
    expect(client.bodies).toHaveLength(1);
    expect(rows[0]).toMatchObject({ validation: 'passed', repair_attempted: false });
  });

  it('structurally invalid output (V0) also goes through repair, and is stored unvalidated if still invalid', async () => {
    const { rows, sink } = sinkOf();
    const broken = { ...repairedReport, observations: [{ ...repairedReport.observations[0]!, evidence_ids: [] }] };
    const { provider } = providerWith(broken, broken);
    await run(provider, sink);
    expect(rows[0]).toMatchObject({ validation: 'failed', repair_attempted: true });
    expect(rows[0]!.violations.some((v) => v.rule === 'V0')).toBe(true);
  });

  it('transport errors are not "repaired" and nothing is stored', async () => {
    const { rows, sink } = sinkOf();
    const { provider } = providerWith('not json at all');
    await expect(run(provider, sink)).rejects.toMatchObject({ kind: 'malformed_response' });
    expect(rows).toEqual([]);
  });
});

describe('validator rules beyond the live report', () => {
  const base = structuredClone(repairedReport);
  it.each([
    ['V1 unknown evidence', (r: any) => { r.observations[0].evidence_ids = ['ev_9']; }, 'V1'],
    ['V2 wrong value', (r: any) => { r.observations[0].values[0].value = 9; }, 'V2'],
    ['V2 nonexistent field', (r: any) => { r.observations[0].values[0].field = 'p95'; }, 'V2'],
    ['V3 unbound placeholder', (r: any) => { r.observations[0].statement += ' {ghost}'; }, 'V3'],
    ['V4 unknown observation', (r: any) => { r.hypotheses[0].supporting_observation_ids = ['obs_9']; }, 'V4'],
    ['V6 timeline outside windows', (r: any) => { r.timeline[0].at = '2026-11-15T00:00:00.000Z'; }, 'V6'],
    ['V7 probable_cause without hypotheses', (r: any) => { r.hypotheses = []; r.recommendations = []; }, 'V7'],
    ['V8 unknown hypothesis in recommendation', (r: any) => { r.recommendations[0].hypothesis_id = 'hyp_9'; }, 'V8'],
  ])('%s', (_n, mutate, rule) => {
    const r = structuredClone(base); mutate(r);
    expect(validateReport(r, evidence).violations.map((v) => v.rule)).toContain(rule);
  });

  it('HTTP 500 / v1.0.1 identifiers present in evidence are not flagged', () => {
    const r = structuredClone(base);
    r.hypotheses[0]!.statement = 'After the v1.0.1 deploy, HTTP 500 responses rose as p95 latency grew.';
    const ev = structuredClone(evidence);
    (ev[3]!.result as any).patterns[0].status = 500;
    expect(validateReport(r, ev).violations).toEqual([]);
  });
});
