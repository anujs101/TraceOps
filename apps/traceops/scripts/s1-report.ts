/**
 * After a live S1 run: read the incident the detector opened and its investigation from the
 * TraceOps API (:4000) and print what /s1-run reports. Reads no env and no .env; talks only to the API.
 *   npx tsx apps/traceops/scripts/s1-report.ts <run-start-iso> [waitSeconds=600]
 *
 * Detection-to-report time = investigation.finished_at − incident.detected_at. The reports table
 * has no created_at column (persistence.md §1); a completed investigation is finished right after
 * its report row is saved, so finished_at is the report time to within one DB write.
 */
import { PORTS } from '@traceops/contracts';

const API = `http://127.0.0.1:${PORTS.traceopsApi}/api`;
const since = process.argv[2];
const waitS = Number(process.argv[3] ?? 600);
if (!since || Number.isNaN(Date.parse(since))) {
  console.error('usage: s1-report.ts <run-start-iso> [waitSeconds]');
  process.exit(1);
}

const get = async (p: string): Promise<any> => {
  const r = await fetch(`${API}${p}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return r.json();
};
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

const deadline = Date.now() + waitS * 1000;
let incident: any = null;
let inv: any = null;
while (Date.now() < deadline) {
  const incidents: any[] = (await get('/incidents')) ?? [];
  incident = incidents.filter((i) => i.service === 'demo-service' && Date.parse(i.detected_at) >= Date.parse(since))
    .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at))[0] ?? null;
  if (incident) {
    const invs: any[] = (await get(`/incidents/${incident.id}/investigations`)) ?? [];
    inv = invs.filter((i) => i.status !== 'running').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] ?? null;
    if (inv) break;
  }
  await sleep(10);
}

const lines: string[] = [];
const out = (s: string) => lines.push(s);
if (!incident) out(`NO INCIDENT detected for demo-service since ${since} (waited ${waitS} s)`);
else {
  out(`incident ${incident.id} · ${incident.group} · severity ${incident.severity} · status ${incident.status} · reopen_count ${incident.reopen_count}`);
  out(`  started_at ${incident.started_at} · detected_at ${incident.detected_at}`);
  out(`  trigger: ${incident.trigger.map((t: any) => `${t.rule_id} observed ${t.observed} > ${t.threshold}`).join('; ')}`);
  if (!inv) out(`NO FINISHED INVESTIGATION within ${waitS} s`);
  else {
    out(`investigation ${inv.id} · ${inv.trigger} · status ${inv.status} · model ${inv.model} · tool_calls ${inv.tool_calls}${inv.error ? ` · error ${inv.error}` : ''}`);
    const report = await get(`/investigations/${inv.id}/report`);
    if (report) {
      const r = report.report ?? {};
      const top = [...(r.hypotheses ?? [])].sort((a: any, b: any) => ['high', 'medium', 'low'].indexOf(a.confidence) - ['high', 'medium', 'low'].indexOf(b.confidence))[0];
      out(`report: status ${r.status} · top hypothesis ${top ? `${top.category} (${top.confidence})` : '-'} · validation ${report.validation} · repair_attempted ${report.repair_attempted}`);
      for (const v of report.violations) out(`  violation [${v.rule}] ${v.path}: ${v.message}`);
      for (const w of report.warnings) out(`  warning (${w.rule}) ${w.path}: ${w.message}`);
    } else out('report: none');
    const calls: any[] = (await get(`/investigations/${inv.id}/llm-calls`)) ?? [];
    const sum = (k: string) => calls.reduce((n, c) => n + (c[k] ?? 0), 0);
    const errs = calls.filter((c) => c.status === 'error');
    out(`llm_calls: ${calls.length} attempts (${errs.length} errors${errs.length ? `: ${[...new Set(errs.map((c) => c.error_kind))].join(', ')}` : ''}) · provider ${[...new Set(calls.map((c) => c.provider))].join(',')} · input ${sum('input_tokens')} · output ${sum('output_tokens')} tokens · latency ${sum('latency_ms')} ms total`);
    const evidence: any[] = (await get(`/investigations/${inv.id}/evidence`)) ?? [];
    out(`evidence: ${evidence.length} rows (${evidence.map((e) => `${e.id}:${e.tool}:${e.status}`).join(' ')})`);
    if (inv.finished_at) out(`detection → report: ${((Date.parse(inv.finished_at) - Date.parse(incident.detected_at)) / 1000).toFixed(1)} s (detected_at → investigation finished_at)`);
  }
}

// defence in depth: nothing key-like leaves this process
const text = lines.join('\n');
if (/gsk_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9]{16,}|\borg_(?!\[REDACTED\])[A-Za-z0-9]+/.test(text)) {
  console.log('KEY SCAN: found a key-like string in the report output; nothing printed.');
  process.exit(2);
}
console.log(text);
