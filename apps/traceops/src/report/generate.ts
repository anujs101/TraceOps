import type { Evidence, ValidationResult } from '@traceops/contracts';
import { LlmError } from '../llm/errors.ts';
import { generateReport } from '../llm/report-stage.ts';
import type { LlmMessage, LlmProvider } from '../llm/types.ts';
import { validateReport } from './validator.ts';
import { repairPrompt } from './repair-prompt.ts';

/** Contracts v1: exactly one repair round. Not configurable on purpose. */
export const MAX_REPAIR_ROUNDS = 1;

export type ReportAttempt = { round: number; output: unknown; validation: ValidationResult };

/** Shape of a `reports` row (persistence.md §1). */
export type ReportRow = {
  investigation_id: string;
  report: unknown; // final attempt as returned by the model (jsonb)
  validation: 'passed' | 'failed';
  violations: ValidationResult['violations'];
  warnings: ValidationResult['warnings'];
  repair_attempted: boolean;
};

export interface ReportSink { save(row: ReportRow): Promise<void> }

export type ReportOutcome = { row: ReportRow; attempts: ReportAttempt[] };

/**
 * Stage B with validation: generate → validate (V0–V8) → at most one repair
 * round with the violation list → validate again → persist. A report that
 * still fails is persisted with validation "failed"; it is never accepted
 * silently and never edited by our code.
 */
export async function generateValidatedReport(
  provider: LlmProvider,
  messages: LlmMessage[],
  evidence: Evidence[],
  opts: { investigationId: string; sink: ReportSink; maxOutputTokens: number; firstTurn?: number; call?: <T>(fn: () => Promise<T>) => Promise<T> },
): Promise<ReportOutcome> {
  const attempts: ReportAttempt[] = [];
  let convo = [...messages];

  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    // each report round is its own llm_calls turn, continuing after the investigate turns
    const trace = { investigationId: opts.investigationId, turn: (opts.firstTurn ?? 1) + round };
    const output = await produce(provider, convo, { ...opts, trace });
    const validation = validateReport(output.value, evidence);
    attempts.push({ round, output: output.value, validation });
    if (validation.passed || round === MAX_REPAIR_ROUNDS) break;
    convo = [
      ...convo,
      { role: 'assistant', content: output.rawText, toolCalls: [] },
      { role: 'user', content: repairPrompt(validation, output.value) },
    ];
  }

  const last = attempts.at(-1)!;
  const row: ReportRow = {
    investigation_id: opts.investigationId,
    report: last.output,
    validation: last.validation.passed ? 'passed' : 'failed',
    violations: last.validation.violations,
    warnings: last.validation.warnings,
    repair_attempted: attempts.length > 1,
  };
  await opts.sink.save(row);
  return { row, attempts };
}

/** Provider output → {value, rawText}. Contract-invalid JSON goes to the validator (V0) instead of aborting. */
async function produce(provider: LlmProvider, messages: LlmMessage[], opts: { maxOutputTokens: number; trace: { investigationId: string; turn: number }; call?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<{ value: unknown; rawText: string }> {
  try {
    const r = await generateReport(provider, messages, { maxOutputTokens: opts.maxOutputTokens, trace: opts.trace, call: opts.call });
    return { value: r.report, rawText: r.raw.rawText };
  } catch (e) {
    if (e instanceof LlmError && e.kind === 'schema_violation') {
      const raw = (e.details as { raw?: StructuredRaw } | undefined)?.raw;
      if (raw) return { value: raw.value, rawText: raw.rawText };
    }
    throw e; // transport/malformed/truncated: not repairable by prompting; the job layer decides on retry
  }
}

type StructuredRaw = { value: unknown; rawText: string };

export { repairPrompt } from './repair-prompt.ts';
