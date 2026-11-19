/**
 * Client for the TraceOps read API (apps/traceops/src/api/server.ts).
 * Types come from the contracts package and the frozen seams; none are redeclared here.
 */
import type { Evidence, Incident, LlmCall } from '@traceops/contracts';
import type { InvestigationRow } from '../../traceops/src/seams.ts';
import type { ReportRow } from '../../traceops/src/report/generate.ts';

export type { Evidence, Incident, LlmCall, InvestigationRow, ReportRow };

export interface Api {
  listIncidents(): Promise<Incident[]>;
  getIncident(id: string): Promise<Incident | null>;
  listInvestigations(incidentId: string): Promise<InvestigationRow[]>;
  getInvestigation(id: string): Promise<InvestigationRow | null>;
  listEvidence(investigationId: string): Promise<Evidence[]>;
  getReport(investigationId: string): Promise<ReportRow | null>;
  listLlmCalls(investigationId: string): Promise<LlmCall[]>;
  rerun(incidentId: string): Promise<{ job_id: string }>;
  cancel(investigationId: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`${status} ${code}`); }
}

export function httpApi(base = ''): Api {
  const req = async <T>(path: string, init?: RequestInit, nullOn404 = false): Promise<T> => {
    const r = await fetch(`${base}/api${path}`, init);
    if (nullOn404 && r.status === 404) return null as T;
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, (body as { error?: string }).error ?? 'error');
    return body as T;
  };
  const id = encodeURIComponent;
  return {
    listIncidents: () => req('/incidents'),
    getIncident: (i) => req(`/incidents/${id(i)}`, undefined, true),
    listInvestigations: (i) => req(`/incidents/${id(i)}/investigations`),
    getInvestigation: (i) => req(`/investigations/${id(i)}`, undefined, true),
    listEvidence: (i) => req(`/investigations/${id(i)}/evidence`),
    getReport: (i) => req(`/investigations/${id(i)}/report`, undefined, true),
    listLlmCalls: (i) => req(`/investigations/${id(i)}/llm-calls`),
    rerun: (i) => req(`/incidents/${id(i)}/rerun`, { method: 'POST' }),
    cancel: async (i) => { await req(`/investigations/${id(i)}/cancel`, { method: 'POST' }); },
  };
}
