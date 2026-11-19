/**
 * The investigator (spec D §5.2): tool loop (stage "investigate") → validated
 * report (stage "report", one repair) → outcome.
 *
 * Outcome mapping follows the contracts exactly:
 *  - a report row was saved (validation "passed" OR "failed")  → completed
 *    (persistence.md §2: "validation: failed and insufficient_evidence are
 *    completed investigations, never retried"; the UI shows "unvalidated")
 *  - cancel_requested observed before a model turn or tool call → cancelled
 *  - any other error (LLM transport after retries, tool layer crash) → failed
 */
import { z } from 'zod';
import type { Evidence } from '@traceops/contracts';
import { LlmError, withRetry, type LlmProvider, type RetryPolicy } from '../llm/index.ts';
import { redactSecrets } from '../llm/errors.ts'; // types.ts: investigator may depend on index/errors/recorder
import { runToolLoop, type LocalTool } from '../llm/tool-loop.ts';
import { generateValidatedReport } from '../report/generate.ts';
import type { EvidenceSink, Investigate, InvestigateInput, InvestigationOutcome } from '../seams.ts';
import { estimateInputTokens, PacedProvider, pacingFor, TokenPacer, type PaceEvent, type PacingConfig } from './pacing.ts';
import { buildReportSystemPrompt, buildReportUserMessage, buildSystemPrompt, buildUserMessage, INVESTIGATION_BUDGET } from './prompt.ts';

export { estimateInputTokens };

/** 429 waits up to ~60 s are honoured (spec D §5.2). */
export const INVESTIGATOR_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 60_000 };

export type InvestigatorOptions = {
  retry?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxTurns?: number;
  chatMaxOutputTokens?: number;
  /**
   * Output cap for each report/repair request. A function receives the request's
   * estimated input tokens, so a TPM-limited account can keep each request under
   * a total (e.g. min(4000, 7500 - input)).
   */
  reportMaxOutputTokens?: number | ((estimatedInputTokens: number) => number);
  /** Called once per report/repair request with the cap that was applied. */
  onReportCap?: (info: { turn: number | undefined; estimatedInputTokens: number; maxOutputTokens: number }) => void;
  /**
   * Tokens-per-minute pacing. Default: looked up by provider name in PROVIDER_PACING
   * (groq: on, deepseek: off). Pass null to disable, or a config to override.
   */
  pacing?: PacingConfig;
  /** Called when a request had to wait for the TPM budget. */
  onPace?: (e: PaceEvent) => void;
};

export class InvestigationCancelled extends Error {
  constructor() { super('investigation cancelled'); this.name = 'InvestigationCancelled'; }
}

/**
 * Wraps the provider so cancel is checked before every model request
 * (each turn, each report round, each retry attempt).
 */
class CancelCheckingProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider, private readonly check: () => Promise<void>) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }
  async chat(req: Parameters<LlmProvider['chat']>[0]) { await this.check(); return this.inner.chat(req); }
  async structured(req: Parameters<LlmProvider['structured']>[0]) { await this.check(); return this.inner.structured(req); }
}

/** Applies a per-request output cap to report/repair requests (no change to the LLM layer). */
class ReportCapProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider, private readonly cap: (n: number) => number, private readonly onCap?: InvestigatorOptions['onReportCap']) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }
  chat(req: Parameters<LlmProvider['chat']>[0]) { return this.inner.chat(req); }
  structured(req: Parameters<LlmProvider['structured']>[0]) {
    const estimatedInputTokens = estimateInputTokens(req);
    const maxOutputTokens = Math.max(1, Math.floor(this.cap(estimatedInputTokens)));
    this.onCap?.({ turn: req.trace?.turn, estimatedInputTokens, maxOutputTokens });
    return this.inner.structured({ ...req, maxOutputTokens });
  }
}

export function makeInvestigate(opts: InvestigatorOptions = {}): Investigate {
  const now = opts.now ?? Date.now;
  return async (input: InvestigateInput): Promise<InvestigationOutcome> => {
    const controller = new AbortController();
    let cancelled = false;
    let toolCalls = 0;
    const check = async () => {
      if (!cancelled && (await input.isCancelled())) { cancelled = true; controller.abort(); }
      if (cancelled) throw new InvestigationCancelled();
    };

    // tee: the validator sees only rows that are durably stored, in order. A row whose write
    // fails is never citable: it is not added here, and the write error propagates to the tool
    // (the model gets a tool_error), so a report can never cite an ev_N the UI can't show.
    const evidence: Evidence[] = [];
    const sink: EvidenceSink = { append: async (row) => { await input.evidence.append(row); evidence.push(row); } };

    const call = <T>(fn: () => Promise<T>) => withRetry(fn, opts.retry ?? INVESTIGATOR_RETRY, opts.sleep);
    const pacing = opts.pacing !== undefined ? opts.pacing : pacingFor(input.provider.name);
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const paced = pacing ? new PacedProvider(input.provider, new TokenPacer(pacing.tokensPerMinute, now, sleep, opts.onPace), check) : input.provider;
    const cap = opts.reportMaxOutputTokens;
    const capped = typeof cap === 'function' ? new ReportCapProvider(paced, cap, opts.onReportCap) : paced;
    // order: cancel check → report cap → pacing (sees the final cap; re-checks cancel after waiting) → provider
    const provider = new CancelCheckingProvider(capped, check);

    try {
      const tools = input.createTools({
        investigationId: input.investigationId,
        incident: input.incident,
        investigationStart: input.investigationStart,
        prometheusUrl: input.prometheusUrl,
        lokiUrl: input.lokiUrl,
        evidence: sink,
        budget: { maxToolCalls: INVESTIGATION_BUDGET.maxToolCalls, deadline: now() + INVESTIGATION_BUDGET.durationMs },
        signal: controller.signal,
      }).map((t): LocalTool<unknown> => ({
        spec: t.spec,
        // Pass raw input through: the tool's own run validates *Checked and records an
        // evidence row for invalid input and budget exhaustion (seams.ts, tools.md §1).
        args: z.unknown(),
        run: async (args, ctx) => {
          if (!cancelled && (await input.isCancelled())) { cancelled = true; controller.abort(); }
          if (cancelled) return { status: 'error', error: 'cancelled' }; // not executed; the next model turn stops the run
          toolCalls++;
          return t.run(args, ctx);
        },
      }));

      const loop = await runToolLoop(provider, [
        { role: 'system', content: buildSystemPrompt(input.incident, input.investigationStart) },
        { role: 'user', content: buildUserMessage(input.incident) },
      ], tools, {
        stage: 'investigate',
        // backstop only; the contract budget is enforced by the tools (they write the rows)
        maxToolCalls: INVESTIGATION_BUDGET.maxToolCalls * 2,
        maxTurns: opts.maxTurns ?? INVESTIGATION_BUDGET.maxToolCalls + 4,
        maxOutputTokens: opts.chatMaxOutputTokens ?? 2048,
        signal: controller.signal,
        trace: { investigationId: input.investigationId, firstTurn: 1 },
        call,
      });

      const { row } = await generateValidatedReport(provider, [
        { role: 'system', content: buildReportSystemPrompt(input.incident, input.investigationStart) },
        { role: 'user', content: buildReportUserMessage(input.incident, evidence, loop.finalText) },
      ], evidence, {
        investigationId: input.investigationId,
        sink: input.reports,
        maxOutputTokens: typeof cap === 'number' ? cap : 6000, // overridden per request when cap is a function
        firstTurn: loop.turns + 1, // turn numbering continues from the tool loop
        call,
      });
      return { status: 'completed', report: row, toolCalls, error: null };
    } catch (e) {
      if (e instanceof InvestigationCancelled || cancelled) return { status: 'cancelled', report: null, toolCalls, error: null };
      return { status: 'failed', report: null, toolCalls, error: describeError(e) };
    }
  };
}

/** Provider account identifiers (e.g. Groq "organization `org_…`") are not secrets but are not shown either. */
export function redactAccountIds(text: string): string {
  return text.replace(/\borg_[A-Za-z0-9]+/g, 'org_[REDACTED]');
}

export function describeError(e: unknown): string {
  const msg = e instanceof LlmError ? `llm_${e.kind}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return redactAccountIds(redactSecrets(msg)).slice(0, 300);
}

export const investigate: Investigate = makeInvestigate();
