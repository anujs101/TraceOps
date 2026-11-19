/**
 * Collect one live run: API rows (incident, investigation, report, evidence, llm_calls) + grade +
 * actual onset order from Prometheus (contract templates). Reads no env / .env.
 *   npx tsx collect-run.ts <S1|S2> <runStartIso> <scenarioSummary.json> <outDir>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deriveWindows, gradeRun, METRIC_NAMES, renderPromql, PORTS } from '/Users/anujs101/Developer/2027/TraceOps/packages/contracts/src/index.ts';

const [scenario, since, summaryPath, outDir] = process.argv.slice(2) as ['S1' | 'S2', string, string, string];
const API = `http://127.0.0.1:${PORTS.traceopsApi}/api`;
const get = async (p: string) => { const r = await fetch(`${API}${p}`); return r.status === 404 ? null : r.json(); };

const scen = JSON.parse(readFileSync(summaryPath, 'utf8'));
const incidents: any[] = await get('/incidents');
const incident = incidents.filter((i) => i.service === 'demo-service' && Date.parse(i.detected_at) >= Date.parse(since)).sort((a, b) => Date.parse(a.detected_at) - Date.parse(b.detected_at))[0];
if (!incident) {
  // no incident for this run (e.g. the alert never fired): record the validity gate only, ungraded
  mkdirSync(outDir, { recursive: true });
  const out = { scenario, run_start: since, validity_gate: { times: scen.times, signal_summary: scen.summary, scenarioValid: scen.verdict }, incident: null, graded: false, note: 'no incident detected for this run' };
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}
const invs: any[] = await get(`/incidents/${incident.id}/investigations`);
const inv = invs.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))[0];
const report = await get(`/investigations/${inv.id}/report`);
const evidence: any[] = await get(`/investigations/${inv.id}/evidence`);
const calls: any[] = await get(`/investigations/${inv.id}/llm-calls`);

// Round 2: does healthy 1.0.0 traffic cover the investigator's derived baseline window?
// covered = baseline ⊂ [tBaselineStart + 60 s (rate[1m] warm-up), tDeploy]
const win = deriveWindows(incident.started_at, inv.started_at);
const baselineCoverage = {
  derived_baseline: win.baseline, derived_incident: win.incident,
  healthy: { start: scen.times.tBaselineStart, deploy: scen.times.tDeploy },
  covered: Date.parse(win.baseline.start) >= Date.parse(scen.times.tBaselineStart) + 60_000 && Date.parse(win.baseline.end) <= Date.parse(scen.times.tDeploy),
  note: 'investigation start approximated by investigation.started_at',
};
const src = (id: string) => evidence.find((e) => e.id === id)?.source;
const grade = gradeRun(scenario, report.report, report.validation === 'passed', src);
const gradeIfPassed = gradeRun(scenario, report.report, true, src);

// actual onsets: baseline = [tBaselineStart, tDeploy]; onset = first t >= tDeploy with 2 consecutive points
// above max(baselineMax * 1.25, mean + 4σ) and a minimum absolute step (5% of baseline max, or 0.01).
async function series(metric: string, start: string, end: string): Promise<[number, number][]> {
  const u = new URL('http://127.0.0.1:9090/api/v1/query_range');
  u.searchParams.set('query', renderPromql(metric as any, 'demo-service'));
  u.searchParams.set('start', String(Date.parse(start) / 1000)); u.searchParams.set('end', String(Date.parse(end) / 1000)); u.searchParams.set('step', '5');
  const j: any = await (await fetch(u)).json();
  return (j.data?.result?.[0]?.values ?? []).map(([t, v]: [number, string]) => [t * 1000, Number(v)]).filter(([, v]: number[]) => Number.isFinite(v));
}
const { tBaselineStart, tDeploy } = scen.times;
const onsets: Array<{ metric: string; onset: string | null; baseline_max: number | null; peak: number | null }> = [];
for (const m of METRIC_NAMES) {
  const base = (await series(m, tBaselineStart, tDeploy)).map(([, v]) => v);
  const run = await series(m, tDeploy, incident.detected_at);
  if (!run.length) { onsets.push({ metric: m, onset: null, baseline_max: null, peak: null }); continue; }
  const bmax = base.length ? Math.max(...base) : 0;
  const mean = base.length ? base.reduce((a, b) => a + b, 0) / base.length : 0;
  const sd = base.length ? Math.sqrt(base.reduce((a, b) => a + (b - mean) ** 2, 0) / base.length) : 0;
  const thr = Math.max(bmax * 1.25, mean + 4 * sd, bmax + Math.max(0.05 * bmax, 0.01));
  let onset: string | null = null;
  for (let i = 0; i + 1 < run.length; i++) if (run[i]![1] > thr && run[i + 1]![1] > thr) { onset = new Date(run[i]![0]).toISOString(); break; }
  onsets.push({ metric: m, onset, baseline_max: bmax, peak: Math.max(...run.map(([, v]) => v)) });
}
const order = onsets.filter((o) => o.onset).sort((a, b) => Date.parse(a.onset!) - Date.parse(b.onset!));

const sum = (k: string) => calls.reduce((n, c) => n + (c[k] ?? 0), 0);
const byTool: Record<string, Record<string, number>> = {};
for (const e of evidence) { byTool[e.tool] ??= {}; byTool[e.tool]![e.status] = (byTool[e.tool]![e.status] ?? 0) + 1; }
const r = report.report;
const out = {
  scenario, run_start: since, provider: calls[0]?.provider, model: inv.model,
  validity_gate: { times: scen.times, signal_summary: scen.summary, scenarioValid: scen.verdict },
  baseline_window: baselineCoverage,
  incident: { id: incident.id, group: incident.group, severity: incident.severity, status: incident.status, started_at: incident.started_at, detected_at: incident.detected_at, resolved_at: incident.resolved_at, reopen_count: incident.reopen_count, trigger: incident.trigger },
  investigation: { id: inv.id, status: inv.status, started_at: inv.started_at, finished_at: inv.finished_at, tool_calls: inv.tool_calls, error: inv.error },
  report: { status: r.status, top_hypothesis: r.hypotheses?.[0] ? { category: r.hypotheses[0].category, confidence: r.hypotheses[0].confidence } : null, hypotheses: (r.hypotheses ?? []).map((h: any) => ({ id: h.id, category: h.category, confidence: h.confidence })), validation: report.validation, repair_attempted: report.repair_attempted, violations: report.violations, warnings_count: report.warnings.length },
  grade: { ...grade, if_validation_had_passed: gradeIfPassed, basis: 'gradeRun (packages/contracts/src/grading.ts)' },
  actual_onset_order: { method: 'Prometheus via contract METRIC_TEMPLATES, step 5 s, baseline [tBaselineStart,tDeploy], onset = first of 2 consecutive points above max(1.25×baseline max, mean+4σ, baseline max + max(5%, 0.01)) in [tDeploy, detected_at]', order: order.map((o) => ({ metric: o.metric, onset: o.onset, baseline_max: o.baseline_max, peak: o.peak })), no_onset: onsets.filter((o) => !o.onset).map((o) => o.metric) },
  evidence: { rows: evidence.length, by_tool_and_status: byTool, calls: evidence.map((e) => `${e.id}:${e.tool}:${e.status}:${JSON.stringify(e.args)}`) },
  detection_to_report_s: inv.finished_at ? (Date.parse(inv.finished_at) - Date.parse(incident.detected_at)) / 1000 : null,
  llm_calls: { attempts: calls.length, errors: calls.filter((c) => c.status === 'error').length, by_stage: calls.reduce((m: any, c) => ((m[c.stage] = (m[c.stage] ?? 0) + 1), m), {}), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), total_tokens: sum('input_tokens') + sum('output_tokens'), latency_ms_total: sum('latency_ms') },
};
const files: Record<string, unknown> = { 'summary.json': out, 'report.json': report, 'evidence.json': evidence, 'llm_calls.json': calls };
for (const [n, v] of Object.entries(files)) {
  const t = JSON.stringify(v, null, 2);
  if (/gsk_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9]{16,}|\borg_(?!\[REDACTED\])[A-Za-z0-9]+/.test(t)) { console.log(`KEY SCAN HIT in ${n}; nothing written`); process.exit(2); }
}
mkdirSync(outDir, { recursive: true });
for (const [n, v] of Object.entries(files)) writeFileSync(`${outDir}/${n}`, JSON.stringify(v, null, 2) + '\n');
console.log(JSON.stringify({ baseline_window: baselineCoverage, report: out.report, grade: out.grade, onset: out.actual_onset_order.order.map((o) => `${o.onset} ${o.metric}`), evidence: out.evidence.calls, llm: out.llm_calls, d2r: out.detection_to_report_s, inc: out.incident }, null, 1));
