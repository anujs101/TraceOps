/**
 * Frozen seams between the Wave 1 build sessions (owned by the main session).
 *
 * The contracts package defines the data. This file defines the few function
 * shapes that one session implements and another consumes, so sessions B, C
 * and D can build in parallel without reading each other's code:
 *
 *   B (tools)        implements CreateTools        → used by D's investigator
 *   C (detector/db)  implements InvestigationStore → used by D's worker and API
 *   D (investigator) implements Investigate        → wired to C's queue by the main session
 *
 * Changing this file follows the same rule as a contract change: stop, write a
 * proposal in docs/proposals/, and let the main session decide.
 */
import type { Evidence, Incident, LlmCall } from '@traceops/contracts';
import type { LocalTool } from './llm/tool-loop.ts';
import type { LlmProvider } from './llm/types.ts';
import type { ReportRow } from './report/generate.ts';

// ── B: tools ────────────────────────────────────────────────────────────────

/** Append-only evidence log for one investigation (evidence-and-report.md §1). */
export interface EvidenceSink {
  append(row: Evidence): Promise<void>;
}

export type ToolContext = {
  investigationId: string;
  /** The incident; `service` is bound from here, never from the model (tools.md §1). */
  incident: Incident;
  /** IsoUtcMs; with incident.started_at it fixes the windows (detection.md §6). */
  investigationStart: string;
  prometheusUrl: string;
  lokiUrl: string;
  evidence: EvidenceSink;
  /** Budget per investigation (tools.md §1): ≤ 12 tool calls, ≤ 3 min. */
  budget: { maxToolCalls: number; deadline: number /* epoch ms */ };
  signal?: AbortSignal;
};

/**
 * Returns the four tools (query_metric, search_logs, log_patterns, log_volume).
 * Each `run` validates against the *Checked schema, executes the template,
 * appends exactly one Evidence row (also for invalid input and budget
 * exhaustion) and returns the tool output the model sees.
 */
export type CreateTools = (ctx: ToolContext) => LocalTool<any>[];

// ── D: investigator ─────────────────────────────────────────────────────────

export type InvestigationOutcome = {
  status: 'completed' | 'failed' | 'cancelled';
  report: ReportRow | null; // completed ⇒ non-null
  toolCalls: number;
  error: string | null;
};

export type InvestigateInput = {
  investigationId: string;
  incident: Incident;
  investigationStart: string;
  provider: LlmProvider;
  createTools: CreateTools;
  evidence: EvidenceSink;
  reports: { save(row: ReportRow): Promise<void> };
  /** Checked before each model turn and tool call (persistence.md §3). */
  isCancelled: () => Promise<boolean>;
  prometheusUrl: string;
  lokiUrl: string;
};

export type Investigate = (input: InvestigateInput) => Promise<InvestigationOutcome>;

// ── C: persistence ──────────────────────────────────────────────────────────

export type InvestigationRow = {
  id: string;
  incident_id: string;
  job_id: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  trigger: 'auto' | 'manual';
  model: string;
  started_at: string;
  finished_at: string | null;
  tool_calls: number;
  cancel_requested: boolean;
  error: string | null;
};

/** Read and write access the worker and API need (persistence.md §1). Times are IsoUtcMs. */
export interface InvestigationStore {
  listIncidents(): Promise<Incident[]>;
  getIncident(id: string): Promise<Incident | null>;
  listInvestigations(incidentId: string): Promise<InvestigationRow[]>;
  getInvestigation(id: string): Promise<InvestigationRow | null>;
  listEvidence(investigationId: string): Promise<Evidence[]>;
  getReport(investigationId: string): Promise<ReportRow | null>;
  listLlmCalls(investigationId: string): Promise<LlmCall[]>;
  /** Manual re-run: idempotency key incident:<id>:manual:<uuid>. Returns the job id. */
  enqueueManual(incidentId: string): Promise<string>;
  requestCancel(investigationId: string): Promise<void>;
  evidenceSink(investigationId: string): EvidenceSink;
  reportSink(investigationId: string): { save(row: ReportRow): Promise<void> };
}
