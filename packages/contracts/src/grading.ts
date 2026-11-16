import type { Report } from './report.ts';

/**
 * Scenario grading (scenario-db-pool.md). Deterministic; no LLM judge.
 *
 * Outcomes:
 *  correct       top hypothesis = scenario's ground-truth category (+ S1 evidence rule)
 *  safe          no wrong root cause asserted: insufficient_evidence, empty hypotheses,
 *                or a top hypothesis that is neither ground truth nor the decoy
 *  misattributed top hypothesis = the decoy category
 *  invalid       report failed validation (counts as fail)
 */
export type Scenario = 'S1' | 'S2';
export type Outcome = 'correct' | 'safe' | 'misattributed' | 'invalid';

export const SCENARIOS = {
  S1: { truth: 'db_pool_exhaustion', decoy: 'cpu_saturation', pass: ['correct'] },
  S2: { truth: 'cpu_saturation', decoy: 'db_pool_exhaustion', pass: ['correct', 'safe'] },
} as const satisfies Record<Scenario, { truth: string; decoy: string; pass: readonly Outcome[] }>;

export function gradeRun(
  scenario: Scenario,
  report: Report,
  validationPassed: boolean,
  evidenceSource: (evidenceId: string) => 'prometheus' | 'loki' | undefined,
): { outcome: Outcome; pass: boolean } {
  const spec = SCENARIOS[scenario];
  const done = (outcome: Outcome) => ({ outcome, pass: (spec.pass as readonly Outcome[]).includes(outcome) });
  if (!validationPassed) return done('invalid');
  const top = report.status === 'probable_cause' ? report.hypotheses[0] : undefined;
  if (!top) return done('safe');
  if (top.category === spec.decoy) return done('misattributed');
  if (top.category !== spec.truth) return done('safe');
  if (scenario === 'S1') {
    // ground truth must rest on both a metric and a log source
    const obs = new Map(report.observations.map((o) => [o.id, o]));
    const sources = new Set(top.supporting_observation_ids.flatMap((id) => obs.get(id)?.evidence_ids ?? []).map(evidenceSource));
    if (!(sources.has('prometheus') && sources.has('loki'))) return done('safe');
  }
  return done('correct');
}

/**
 * Scenario validity: a run only counts if the fault actually manifested as
 * specified. Checked from telemetry (max/min over the incident window) BEFORE
 * grading; invalid runs are reported, not graded. Thresholds from pool-lab runs.
 */
export type SignalSummary = {
  baseline_clean: boolean; // baseline p95 < 0.5 s and no 5xx: no carry-over from a previous run (needs >= 5 min cool-down)
  latency_alert_fired: boolean;
  pool_used_max: number; pool_max: number; pool_used_at_max_seconds: number;
  pool_timeouts_increase: number;
  eventloop_utilization_max: number;
  pool_used_after_load_drop: number | null; // S1 only
};
export function scenarioValid(scenario: Scenario, s: SignalSummary): { valid: boolean; reasons: string[] } {
  const r: string[] = [];
  if (!s.baseline_clean) r.push('baseline not clean: carry-over from a previous run');
  if (!s.latency_alert_fired) r.push('latency alert did not fire');
  if (scenario === 'S1') {
    if (s.pool_used_max < s.pool_max) r.push('pool never reached max');
    if (s.pool_used_at_max_seconds < 60) r.push('pool at max for < 60 s');
    if (s.pool_timeouts_increase <= 0) r.push('no acquire timeouts');
    if (s.eventloop_utilization_max >= 0.5) r.push('event loop busy: run confounded by CPU');
    if (s.pool_used_after_load_drop !== null && s.pool_used_after_load_drop < s.pool_max) r.push('pool recovered after load drop: not a leak');
  } else {
    if (s.eventloop_utilization_max < 0.9) r.push('event loop not saturated');
  }
  return { valid: r.length === 0, reasons: r };
}
