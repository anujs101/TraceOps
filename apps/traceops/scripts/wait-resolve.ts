/**
 * After a scenario: wait until the run's incident resolves NORMALLY (every rule in its group back
 * to ok for resolve_after ticks, detection.md §4). Needs demo-service running healthy under load
 * (FAULT=none), otherwise the rules see missing data and never recover. Talks only to the API.
 *   npx tsx apps/traceops/scripts/wait-resolve.ts <run-start-iso> [capSeconds=300]
 * Exit 0: resolved. Exit 3: still open at the cap (printed loudly; nothing is edited).
 * Exit 1: no incident for this run.
 */
import { PORTS } from '@traceops/contracts';

const API = `http://127.0.0.1:${PORTS.traceopsApi}/api`;
const since = process.argv[2];
const capS = Number(process.argv[3] ?? 300);
if (!since || Number.isNaN(Date.parse(since))) {
  console.error('usage: wait-resolve.ts <run-start-iso> [capSeconds]');
  process.exit(1);
}
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const stamp = () => new Date().toISOString();

const list = async (): Promise<any[]> => (await (await fetch(`${API}/incidents`)).json()) as any[];
const runIncidents = (all: any[]) => all.filter((i) => i.service === 'demo-service' && Date.parse(i.detected_at) >= Date.parse(since));

const first = runIncidents(await list());
if (first.length === 0) {
  console.log(`${stamp()} no incident detected since ${since}; nothing to wait for`);
  process.exit(1);
}
const t0 = Date.now();
for (;;) {
  const open = runIncidents(await list()).filter((i) => i.status === 'open');
  const waited = Math.round((Date.now() - t0) / 1000);
  if (open.length === 0) {
    const all = runIncidents(await list());
    for (const i of all) console.log(`${stamp()} RESOLVED incident ${i.id} · resolved_at ${i.resolved_at} · reopen_count ${i.reopen_count} (waited ${waited} s)`);
    process.exit(0);
  }
  if (waited >= capS) {
    for (const i of open) console.log(`!!! ${stamp()} INCIDENT STILL OPEN after ${capS} s: ${i.id} (${i.group}, detected ${i.detected_at}). It did not resolve normally. Nothing was edited; check the detector log for missing data / rule phases before the next run. !!!`);
    process.exit(3);
  }
  if (waited % 30 === 0) console.log(`${stamp()} waiting: ${open.length} open incident(s), ${waited}/${capS} s`);
  await sleep(5);
}
