/**
 * Loads a recorded live run (docs/runs/<run>/: summary, evidence, report,
 * llm_calls) into a MemoryStore, as the worker would have written it. Real
 * data only: the only additions are the row fields a run summary does not
 * record (job_id, cancel_requested, resolved_at when absent).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MemoryStore } from '../../traceops/src/api/memory-store.ts';

export const RUNS_DIR = resolve(import.meta.dirname, '../../../docs/runs');

const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const FILES = ['summary.json', 'evidence.json', 'report.json', 'llm_calls.json'];

export function runDirs(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR).sort().map((d) => join(RUNS_DIR, d)).filter((d) => FILES.every((f) => existsSync(join(d, f))));
}

export function loadRun(store: MemoryStore, dir: string): { incidentId: string; investigationId: string } {
  const summary = read(dir, 'summary.json');
  const inc = summary.incident, inv = summary.investigation;
  store.addIncident({ resolved_at: null, ...inc });
  store.putInvestigation({ job_id: null, cancel_requested: false, ...inv, incident_id: inc.id });
  store.evidence.set(inv.id, read(dir, 'evidence.json'));
  store.reports.set(inv.id, read(dir, 'report.json'));
  for (const c of read(dir, 'llm_calls.json')) store.addLlmCall(c);
  return { incidentId: inc.id, investigationId: inv.id };
}
