import { Report, ReportApi, toApiJsonSchema, type Report as ReportT } from '@traceops/contracts';
import { LlmError } from './errors.ts';
import type { CallTrace, JsonSchema, LlmMessage, LlmProvider, StructuredResult } from './types.ts';

/**
 * Stage 2: structured report generation, a SEPARATE request from tool calling
 * (Groq cannot combine structured outputs and tool use).
 *
 * The provider receives the API-layer schema (ReportApi). The response is then
 * validated with the full checked `Report` schema from Contracts v1. Provider
 * limits never weaken server-side validation: a provider-valid but
 * contract-invalid report is a `schema_violation`.
 */
export const REPORT_SCHEMA_NAME = 'investigation_report';

export function reportProviderSchema(): JsonSchema {
  return toApiJsonSchema(ReportApi);
}

export type ReportStageResult = { report: ReportT; raw: StructuredResult };

export async function generateReport(provider: LlmProvider, messages: LlmMessage[], opts: { maxOutputTokens: number; signal?: AbortSignal; trace?: CallTrace; call?: <T>(fn: () => Promise<T>) => Promise<T> }): Promise<ReportStageResult> {
  const call = opts.call ?? ((fn) => fn());
  const raw = await call(() => provider.structured({
    stage: 'report', trace: opts.trace, messages, schemaName: REPORT_SCHEMA_NAME, schema: reportProviderSchema(),
    maxOutputTokens: opts.maxOutputTokens, signal: opts.signal,
  }));
  const checked = Report.safeParse(raw.value);
  if (!checked.success) {
    throw new LlmError('schema_violation', `report failed contract validation: ${checked.error.issues.length} issue(s)`, {
      details: {
        issues: checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        raw: { value: raw.value, rawText: raw.rawText }, // kept in memory for the repair round / unvalidated storage; never logged
      },
    });
  }
  return { report: checked.data, raw };
}
