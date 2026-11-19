/**
 * Per-incident summary for the list: the latest investigation and its report.
 * The API has no summary endpoint, so this is N+1 reads (fine at demo scale).
 */
import { ReportApi, type Report } from '@traceops/contracts';
import type { Api, Incident, InvestigationRow, ReportRow } from '../api.ts';

export type IncidentSummary = {
  incident: Incident;
  latest: InvestigationRow | null;
  row: ReportRow | null;
  top: Report['hypotheses'][number] | null;
  count: number;
};

export async function summarise(api: Api, incident: Incident): Promise<IncidentSummary> {
  const invs = await api.listInvestigations(incident.id);
  const latest = invs[0] ?? null; // store returns newest first
  const row = latest && latest.status !== 'running' ? await api.getReport(latest.id) : null;
  const parsed = row ? ReportApi.safeParse(row.report) : null;
  return { incident, latest, row, top: parsed?.success ? parsed.data.hypotheses[0] ?? null : null, count: invs.length };
}

export async function summariseAll(api: Api): Promise<IncidentSummary[]> {
  const incidents = await api.listIncidents();
  return Promise.all(incidents.map((i) => summarise(api, i)));
}
