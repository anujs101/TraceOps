/**
 * LIVE (spends provider tokens): one investigation with the configured provider
 * (LLM_PROVIDER, via createLlmProvider) over the fixture-backed tools and an
 * in-memory store. Run only when asked.
 *   npx tsx apps/traceops/src/investigator/live-run.ts
 *
 * Tool turns are capped at 1024 output tokens. Each report/repair request is
 * capped at min(4000, budget - estimated input), where budget is the provider's
 * tokens-per-minute pacing budget (PROVIDER_PACING; no budget → 4000).
 * Groq only: reasoning_effort low (GROQ_REASONING_EFFORT).
 *
 * All output is buffered and scanned for the API key before anything is printed.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLlmProvider, MemoryRecorder, toLlmCallRow } from '../llm/index.ts';
import { MemoryStore } from '../api/memory-store.ts';
import { fixtureCreateTools, S1_INCIDENT, S1_INVESTIGATION_START } from './dev/fixture-tools.ts';
import { makeInvestigate, redactAccountIds } from './investigate.ts';
import { pacingFor } from './pacing.ts';
import { INVESTIGATION_BUDGET } from './prompt.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env')); // loaded into env, never read or printed here; existing env wins
const env: NodeJS.ProcessEnv = { ...process.env, GROQ_REASONING_EFFORT: 'low' };

const REPORT_MAX = 4000, LOW_CAP = 1500, TOOL_TURN_MAX = 1024;
const lines: string[] = [];
const out = (s: string) => lines.push(s);

const recorder = new MemoryRecorder();
const provider = createLlmProvider(recorder, env);
const store = new MemoryStore();
const tools = fixtureCreateTools();
const id = randomUUID();
const sleeps: number[] = [];
const paceWaits: number[] = [];
const pacing = pacingFor(provider.name);
const TOTAL_PER_REQUEST = pacing?.tokensPerMinute ?? Infinity;
out(`provider ${provider.name} · model ${provider.model} · pacing ${pacing ? `${pacing.tokensPerMinute} tokens/min` : 'off'}`);

store.addIncident(S1_INCIDENT);
const investigationStart = S1_INVESTIGATION_START; // fixture windows end here
store.putInvestigation({ id, incident_id: S1_INCIDENT.id, job_id: null, status: 'running', trigger: 'manual', model: provider.model, started_at: new Date().toISOString(), finished_at: null, tool_calls: 0, cancel_requested: false, error: null });

const investigate = makeInvestigate({
  chatMaxOutputTokens: TOOL_TURN_MAX,
  reportMaxOutputTokens: (n) => Math.min(REPORT_MAX, TOTAL_PER_REQUEST - n),
  onReportCap: (c) => out(`report cap: turn ${c.turn} est_input ${c.estimatedInputTokens} → max_completion_tokens ${c.maxOutputTokens}${c.maxOutputTokens < LOW_CAP ? `  (LOW: < ${LOW_CAP}, proceeding)` : ''}`),
  onPace: (e) => { paceWaits.push(e.waitedMs); out(`pacing wait ${e.waitedMs} ms (window ${e.windowTokens} + reserve ${e.reserved})`); },
  sleep: async (ms) => { sleeps.push(ms); await new Promise((r) => setTimeout(r, ms)); },
});

const t0 = Date.now();
const outcome = await investigate({
  investigationId: id, incident: S1_INCIDENT, investigationStart, provider, createTools: tools.create,
  evidence: store.evidenceSink(id), reports: store.reportSink(id), isCancelled: async () => false,
  prometheusUrl: 'http://fixture.invalid', lokiUrl: 'http://fixture.invalid',
});
const wallMs = Date.now() - t0;
store.putInvestigation({ ...(await store.getInvestigation(id))!, status: outcome.status, tool_calls: outcome.toolCalls, error: outcome.error, finished_at: new Date().toISOString() });

// llm_calls.error_message comes from the LLM layer, which does not redact account ids
const rows = recorder.records.map((r) => toLlmCallRow({ ...r, errorMessage: r.errorMessage === null ? null : redactAccountIds(r.errorMessage) }));
for (const r of rows) store.addLlmCall(r);
const evidence = await store.listEvidence(id);
const report = await store.getReport(id);
const deadline = tools.contexts[0]?.budget.deadline ?? Infinity;

out('\n=== llm_calls ===');
out('turn att stage       kind        status err_kind     in_tok out_tok latency_ms stop       tools retry_after_ms');
for (const r of rows) {
  out([r.turn, r.attempt, r.stage.padEnd(11), r.kind.padEnd(11), r.status.padEnd(6), String(r.error_kind ?? '-').padEnd(12), String(r.input_tokens ?? '-').padStart(6), String(r.output_tokens ?? '-').padStart(7), String(r.latency_ms).padStart(10), String(r.stop_reason ?? '-').padEnd(10), String(r.tool_call_count ?? '-').padStart(5), r.retry_after_ms ?? '-'].join(' '));
}
const sum = (k: 'input_tokens' | 'output_tokens') => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
out(`totals: input ${sum('input_tokens')} · output ${sum('output_tokens')} · calls ${rows.length} (ok ${rows.filter((r) => r.status === 'ok').length}, error ${rows.filter((r) => r.status === 'error').length})`);
const paceMs = paceWaits.reduce((a, b) => a + b, 0), allMs = sleeps.reduce((a, b) => a + b, 0);
out(`429s: ${rows.filter((r) => r.error_kind === 'rate_limit').length} rate-limited attempts · pacing waits ${paceWaits.length} (${paceMs} ms) · retry waits ${allMs - paceMs} ms`);
out(`wall time: ${(wallMs / 1000).toFixed(1)} s · 3-min tool deadline hit: ${evidence.some((e) => e.status === 'budget_exhausted' && Date.parse(e.created_at) > deadline) ? 'YES' : 'no'} (${tools.executed()} tools executed of ${INVESTIGATION_BUDGET.maxToolCalls})`);

out('\n=== evidence ===');
for (const e of evidence) out(`${e.id} ${e.tool} ${e.status} args=${JSON.stringify(e.args)}${e.error ? ` error=${e.error}` : ''}`);

out('\n=== outcome ===');
out(JSON.stringify({ status: outcome.status, toolCalls: outcome.toolCalls, error: outcome.error }));
if (report) {
  out(`report saved: validation ${report.validation} · repair_attempted ${report.repair_attempted} · violations ${report.violations.length} · warnings ${report.warnings.length}`);
  for (const v of report.violations) out(`  [${v.rule}] ${v.path}: ${v.message}`);
  for (const w of report.warnings) out(`  (warn ${w.rule}) ${w.path}: ${w.message}`);
  const r = report.report as any;
  if (r?.hypotheses) out(`  status ${r.status} · hypotheses: ${r.hypotheses.map((h: any) => `${h.id}:${h.category}/${h.confidence}`).join(', ')}`);
} else out('no report saved');

const runsDir = join(import.meta.dirname, '..', '..', 'runs'); mkdirSync(runsDir, { recursive: true });
const file = join(runsDir, `investigation-live-${Date.now()}.json`);

// ── key scan before anything leaves the process ──
const text = lines.join('\n');
const blob = JSON.stringify({ outcome, rows, evidence, report });
// every provider key variable (GROQ_API_KEY today; the DeepSeek adapter's own name later)
const keys = Object.entries(env).filter(([k, v]) => /_API_KEY$/.test(k) && v && v.trim().length >= 8).map(([, v]) => v!.trim());
const leaked = (s: string) => keys.some((k) => s.includes(k)) || /gsk_[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{20,}/.test(s) || /\borg_(?!\[REDACTED\])[A-Za-z0-9]+/.test(s);
if (leaked(text) || leaked(blob)) {
  console.log('KEY SCAN: FOUND a key-like string in the output; nothing printed or saved.');
  process.exit(2);
}
writeFileSync(file, JSON.stringify({ investigationId: id, wallMs, sleeps, outcome, rows, evidence, report }, null, 1));
console.log('KEY SCAN: clean (no API key value, no key-like or org_ id in output or saved run)');
console.log(text);
console.log(`\nsaved: ${file}`);
