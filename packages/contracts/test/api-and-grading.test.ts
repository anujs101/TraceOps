import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ReportApi, TOOL_INPUTS, toApiJsonSchema, structuredOutputProblems, gradeRun, scenarioValid } from '../src/index.ts';
import { validReport } from './examples.ts';

describe('structured-output compatibility (offline, against documented limits)', () => {
  it('report schema sent as output_config.format has no unsupported features', () => {
    expect(structuredOutputProblems(toApiJsonSchema(ReportApi))).toEqual([]);
  });
  it.each(Object.entries(TOOL_INPUTS))('tool input %s is valid for strict tool use', (_n, schema) => {
    expect(structuredOutputProblems(toApiJsonSchema(schema))).toEqual([]);
  });
  it('the checker catches what the API rejects', () => {
    const bad = toApiJsonSchema(z.object({ a: z.string().max(5), b: z.number().min(1).optional() }));
    expect(structuredOutputProblems(bad).join('\n')).toMatch(/maxLength[\s\S]*minimum|minimum[\s\S]*maxLength/);
    expect(structuredOutputProblems(bad).join('\n')).toMatch(/optional properties/);
  });
});

const src = (id: string): 'prometheus' | 'loki' => (id === 'ev_1' ? 'prometheus' : 'loki');
const withTop = (category: string) => ({ ...validReport, hypotheses: [{ ...validReport.hypotheses[0]!, category: category as any }] });

describe('grading', () => {
  it('S1: correct only with pool category backed by metric AND log evidence', () => {
    expect(gradeRun('S1', validReport, true, src)).toEqual({ outcome: 'correct', pass: true });
    expect(gradeRun('S1', validReport, true, () => 'prometheus')).toEqual({ outcome: 'safe', pass: false });
    expect(gradeRun('S1', withTop('cpu_saturation'), true, src)).toEqual({ outcome: 'misattributed', pass: false });
    expect(gradeRun('S1', validReport, false, src)).toEqual({ outcome: 'invalid', pass: false });
  });
  it('S2: cpu is correct; empty hypotheses / insufficient evidence is safe (pass); pool on top fails', () => {
    expect(gradeRun('S2', withTop('cpu_saturation'), true, src)).toEqual({ outcome: 'correct', pass: true });
    expect(gradeRun('S2', { ...validReport, status: 'insufficient_evidence', hypotheses: [] }, true, src)).toEqual({ outcome: 'safe', pass: true });
    expect(gradeRun('S2', withTop('other'), true, src)).toEqual({ outcome: 'safe', pass: true });
    expect(gradeRun('S2', validReport, true, src)).toEqual({ outcome: 'misattributed', pass: false });
  });
  it('S2: a secondary pool hypothesis below a CPU top hypothesis is allowed', () => {
    const r = { ...validReport, hypotheses: [{ ...validReport.hypotheses[0]!, id: 'hyp_1', category: 'cpu_saturation' as const },
      { ...validReport.hypotheses[0]!, id: 'hyp_2', confidence: 'medium' as const }] };
    expect(gradeRun('S2', r, true, src).outcome).toBe('correct');
  });
});

describe('scenario validity gate', () => {
  const s1 = { baseline_clean: true, latency_alert_fired: true, pool_used_max: 10, pool_max: 10, pool_used_at_max_seconds: 120, pool_timeouts_increase: 50, eventloop_utilization_max: 0.2, pool_used_after_load_drop: 10 };
  it('accepts a clean S1 run and rejects a CPU-confounded or recovering one', () => {
    expect(scenarioValid('S1', s1).valid).toBe(true);
    expect(scenarioValid('S1', { ...s1, eventloop_utilization_max: 0.95 }).reasons).toContain('event loop busy: run confounded by CPU');
    expect(scenarioValid('S1', { ...s1, pool_used_after_load_drop: 3 }).reasons).toContain('pool recovered after load drop: not a leak');
  });
  it('rejects runs whose baseline carries over a previous run', () => {
    expect(scenarioValid('S1', { ...s1, baseline_clean: false }).reasons).toContain('baseline not clean: carry-over from a previous run');
  });
  it('requires a saturated event loop for S2', () => {
    expect(scenarioValid('S2', { ...s1, eventloop_utilization_max: 0.5, pool_used_after_load_drop: null }).valid).toBe(false);
  });
});
