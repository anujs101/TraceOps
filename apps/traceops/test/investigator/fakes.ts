/**
 * Test doubles for the investigator. Nothing here talks to a network.
 * The provider and tools live in src/investigator/dev/ so the dev API seed and
 * the live run can reuse them; tests import them from here.
 */
import type { Evidence } from '@traceops/contracts';
import type { ReportRow } from '../../src/report/generate.ts';

export { ScriptedProvider, type ChatStep, type StructuredStep, type Step } from '../../src/investigator/dev/scripted-provider.ts';
export { fixtureCreateTools, S1_INCIDENT, S1_INVESTIGATION_START as INVESTIGATION_START, type FixtureToolsHandle } from '../../src/investigator/dev/fixture-tools.ts';

export const INV_ID = '00000000-0000-4000-8000-0000000000d1';

/** In-memory sinks for evidence and reports. */
export function memorySinks() {
  const evidence: Evidence[] = [];
  const reports: ReportRow[] = [];
  return { evidence, reports, evidenceSink: { append: async (r: Evidence) => { evidence.push(r); } }, reportSink: { save: async (r: ReportRow) => { reports.push(r); } } };
}
