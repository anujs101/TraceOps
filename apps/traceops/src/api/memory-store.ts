/**
 * In-memory InvestigationStore (seams.ts) for API tests and UI development.
 * The Postgres implementation (session C) replaces it at merge. Writes here are
 * only what the worker would do; the API itself never writes reports or evidence.
 */
import { randomUUID } from 'node:crypto';
import type { Evidence, Incident, LlmCall } from '@traceops/contracts';
import type { ReportRow } from '../report/generate.ts';
import type { EvidenceSink, InvestigationRow, InvestigationStore } from '../seams.ts';

export type EnqueuedJob = { id: string; incident_id: string; idempotency_key: string };

export class MemoryStore implements InvestigationStore {
  readonly incidents = new Map<string, Incident>();
  readonly investigations = new Map<string, InvestigationRow>();
  readonly evidence = new Map<string, Evidence[]>();
  readonly reports = new Map<string, ReportRow>();
  readonly llmCalls = new Map<string, LlmCall[]>();
  readonly jobs: EnqueuedJob[] = [];

  // ── seeding (what detector/worker would write) ──
  addIncident(i: Incident) { this.incidents.set(i.id, i); }
  putInvestigation(row: InvestigationRow) { this.investigations.set(row.id, row); }
  addLlmCall(row: LlmCall) { this.llmCalls.set(row.investigation_id, [...(this.llmCalls.get(row.investigation_id) ?? []), row]); }

  // ── InvestigationStore ──
  async listIncidents() { return [...this.incidents.values()].sort((a, b) => b.detected_at.localeCompare(a.detected_at)); }
  async getIncident(id: string) { return this.incidents.get(id) ?? null; }
  async listInvestigations(incidentId: string) {
    return [...this.investigations.values()].filter((r) => r.incident_id === incidentId).sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  async getInvestigation(id: string) { return this.investigations.get(id) ?? null; }
  async listEvidence(investigationId: string) { return [...(this.evidence.get(investigationId) ?? [])]; }
  async getReport(investigationId: string) { return this.reports.get(investigationId) ?? null; }
  async listLlmCalls(investigationId: string) {
    return [...(this.llmCalls.get(investigationId) ?? [])].sort((a, b) => a.turn - b.turn || a.attempt - b.attempt);
  }
  async enqueueManual(incidentId: string) {
    const job: EnqueuedJob = { id: randomUUID(), incident_id: incidentId, idempotency_key: `incident:${incidentId}:manual:${randomUUID()}` };
    this.jobs.push(job);
    return job.id;
  }
  async requestCancel(investigationId: string) {
    const r = this.investigations.get(investigationId);
    if (r) this.investigations.set(investigationId, { ...r, cancel_requested: true });
  }
  evidenceSink(investigationId: string): EvidenceSink {
    return { append: async (row) => { this.evidence.set(investigationId, [...(this.evidence.get(investigationId) ?? []), row]); } };
  }
  reportSink(investigationId: string) {
    return { save: async (row: ReportRow) => { this.reports.set(investigationId, row); } };
  }
}
