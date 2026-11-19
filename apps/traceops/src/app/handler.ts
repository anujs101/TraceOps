/**
 * The worker's job handler: one claimed investigation_jobs row → one investigations row → D's
 * investigate() over B's live tools, persisting evidence, the report and every llm_calls attempt.
 *
 * Resolve vs throw follows persistence.md §2 and the Worker contract (src/queue/worker.ts):
 *  - completed (validation passed OR failed, incl. insufficient_evidence) → resolve: job done, never retried
 *  - cancelled → resolve
 *  - failed with a non-retryable LLM error (auth, bad_request, …) → resolve: retrying cannot help
 *  - failed otherwise (retryable LLM kinds after the investigator's own retries, DB/tool-layer
 *    errors) → throw: the worker requeues until max_attempts, then dead
 * The LLM error kind is read with the investigator's parseOutcomeError (the inverse of the
 * describeError that wrote it), never by parsing the string here.
 */
import { RETRYABLE_LLM_ERRORS, type Incident } from '@traceops/contracts';
import { parseOutcomeError } from '../investigator/investigate.ts';
import type { CallRecorder, LlmProvider } from '../llm/index.ts';
import type { CreateTools, EvidenceSink, Investigate, InvestigationOutcome, InvestigationRow } from '../seams.ts';
import type { ReportRow } from '../report/generate.ts';
import type { Job } from '../queue/queue.ts';
import type { JobHandler } from '../queue/worker.ts';
import { PgCallRecorder, type LlmCallSink } from './pg-recorder.ts';

/** The PgInvestigationStore methods the handler uses (narrow, so tests can see what is touched). */
export type HandlerStore = LlmCallSink & {
  failRunningForJob(jobId: string): Promise<number>;
  getIncident(id: string): Promise<Incident | null>;
  getInvestigation(id: string): Promise<InvestigationRow | null>;
  createInvestigation(i: { incidentId: string; jobId: string | null; trigger: 'auto' | 'manual'; model: string; startedAt?: string }): Promise<InvestigationRow>;
  finishInvestigation(id: string, f: { status: 'completed' | 'failed' | 'cancelled'; toolCalls: number; error: string | null }): Promise<void>;
  evidenceSink(investigationId: string): EvidenceSink;
  reportSink(investigationId: string): { save(row: ReportRow): Promise<void> };
};

export type HandlerLog = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export type HandlerDeps = {
  store: HandlerStore;
  investigate: Investigate;
  createTools: CreateTools;
  /** Builds the configured provider around this job's recorder (createLlmProvider in production). */
  makeProvider: (recorder: CallRecorder) => LlmProvider;
  prometheusUrl: string;
  lokiUrl: string;
  now?: () => Date;
  log?: HandlerLog;
};

export const jobTrigger = (key: string): 'auto' | 'manual' => (key.endsWith(':auto') ? 'auto' : 'manual');

/** Whether a finished outcome should make the worker retry the job (persistence.md §2). */
export function shouldRetry(o: InvestigationOutcome): boolean {
  if (o.status !== 'failed') return false;
  const kind = parseOutcomeError(o.error)?.llmKind ?? null;
  return kind === null || RETRYABLE_LLM_ERRORS.includes(kind);
}

export class RetryableInvestigationFailure extends Error {
  constructor(readonly investigationId: string, detail: string | null) {
    super(`investigation ${investigationId} failed (retryable): ${detail ?? 'unknown'}`);
    this.name = 'RetryableInvestigationFailure';
  }
}

export function makeJobHandler(d: HandlerDeps): JobHandler {
  const now = d.now ?? (() => new Date());
  const log = d.log ?? ((level, msg, f) => console[level === 'info' ? 'log' : level](`[handler] ${msg}`, f ?? ''));

  return async (job: Job) => {
    // A reclaimed job's previous attempt may still look `running`: its worker is gone.
    const closed = await d.store.failRunningForJob(job.id);
    if (closed > 0) log('warn', 'closed investigations of a lost worker', { job: job.id, closed });

    const incident = await d.store.getIncident(job.incident_id);
    if (!incident) throw new Error(`job ${job.id}: incident ${job.incident_id} not found`);

    const recorder = new PgCallRecorder(d.store, (m, f) => log('warn', `llm_calls ${m}`, f));
    const provider = d.makeProvider(recorder);
    const inv = await d.store.createInvestigation({ incidentId: incident.id, jobId: job.id, trigger: jobTrigger(job.idempotency_key), model: provider.model });
    log('info', 'investigation started', { job: job.id, attempt: job.attempts, investigation: inv.id, incident: incident.id, provider: provider.name, model: provider.model });

    let outcome: InvestigationOutcome;
    try {
      outcome = await d.investigate({
        investigationId: inv.id,
        incident,
        investigationStart: now().toISOString(),
        provider,
        createTools: d.createTools,
        evidence: d.store.evidenceSink(inv.id),
        reports: d.store.reportSink(inv.id),
        isCancelled: async () => (await d.store.getInvestigation(inv.id))?.cancel_requested ?? false,
        prometheusUrl: d.prometheusUrl,
        lokiUrl: d.lokiUrl,
      });
    } catch (e) {
      // investigate() is not expected to throw; if it does, close the row and let the worker retry.
      await recorder.flush();
      await d.store.finishInvestigation(inv.id, { status: 'failed', toolCalls: 0, error: 'handler_error' }).catch(() => undefined);
      throw e;
    }

    const { failures } = await recorder.flush();
    if (failures > 0) log('warn', 'some llm_calls rows were not written', { investigation: inv.id, failures });
    await d.store.finishInvestigation(inv.id, { status: outcome.status, toolCalls: outcome.toolCalls, error: outcome.error });
    log('info', 'investigation finished', { investigation: inv.id, status: outcome.status, validation: outcome.report?.validation ?? null, tool_calls: outcome.toolCalls, error: outcome.error });

    if (shouldRetry(outcome)) throw new RetryableInvestigationFailure(inv.id, outcome.error);
  };
}
