/**
 * DEV/TEST ONLY: a CreateTools whose outputs come from the REAL S1 fixtures
 * (via scripts/lib/fixture-evidence.ts). Follows the seams.ts contract: the
 * args schema is permissive, `run` validates *Checked, and every call appends
 * exactly one evidence row (also invalid input and budget exhaustion).
 * The real adapters (session B) replace this at merge.
 */
import {
  deriveStats, LogPatternsChecked, LogVolumeChecked, QueryMetricChecked, renderPromql, SearchLogsChecked, TOOL_INPUTS, toApiJsonSchema, toIsoUtcMs,
  type Evidence, type Incident, type ToolName,
} from '@traceops/contracts';
import { z } from 'zod';
import type { LocalTool } from '../../llm/tool-loop.ts';
import type { CreateTools, ToolContext } from '../../seams.ts';
import { TOOL_DESCRIPTIONS } from '../prompt.ts';
import { logPatternsOutput, logVolumeOutput, manifest, queryMetricOutput, searchLogsOutput } from '../../../scripts/lib/fixture-evidence.ts';

/** The fixture windows end at the capture end, so the investigation "starts" there. */
export const S1_INVESTIGATION_START = manifest.end as string;

/** An incident consistent with the S1 fixture timeline (fault at deploy_at, alert ~1 min later). */
export const S1_INCIDENT: Incident = {
  id: '00000000-0000-4000-8000-0000000000a1',
  fingerprint: 'a'.repeat(64),
  service: manifest.service,
  group: 'http',
  status: 'open',
  severity: 'critical',
  started_at: '2026-11-16T18:27:00.000Z',
  detected_at: '2026-11-16T18:27:30.000Z',
  resolved_at: null,
  reopen_count: 0,
  trigger: [{ rule_id: 'latency_p95_high', query: 'latency_p95', threshold: 0.5, observed: 2.1, at: '2026-11-16T18:27:30.000Z' }],
};

const CHECKED = { query_metric: QueryMetricChecked, search_logs: SearchLogsChecked, log_patterns: LogPatternsChecked, log_volume: LogVolumeChecked } as const;
const LOKI_FIXTURE: Record<Exclude<ToolName, 'query_metric'>, string> = {
  search_logs: 'loki-search-errors-exception.json', log_patterns: 'loki-patterns-sample.json', log_volume: 'loki-volume.json',
};

function fixtureOutput(name: ToolName, a: any): Record<string, unknown> {
  switch (name) {
    case 'query_metric': return queryMetricOutput(a.metric);
    case 'search_logs': return searchLogsOutput(Math.min(a.limit ?? 5, 5));
    case 'log_patterns': return logPatternsOutput();
    case 'log_volume': return logVolumeOutput();
  }
}

function renderedQuery(name: ToolName, a: any, service: string): string {
  // metrics: the real contract template; logs: the committed fixture file (the LogQL is session B's)
  return name === 'query_metric' ? renderPromql(a.metric, service) : `fixture S1/${LOKI_FIXTURE[name]}`;
}

export type FixtureToolsHandle = { create: CreateTools; contexts: ToolContext[]; executed: () => number };

export function fixtureCreateTools(opts: { now?: () => number } = {}): FixtureToolsHandle {
  const now = opts.now ?? Date.now;
  const contexts: ToolContext[] = [];
  let executed = 0;
  const create: CreateTools = (ctx) => {
    contexts.push(ctx);
    let seq = 0;
    const append = async (name: ToolName, args: unknown, output: Record<string, unknown>, error: string | null, window: Evidence['window'], query: string | null) => {
      const id = `ev_${++seq}`;
      const result = { evidence_id: id, ...output };
      const row: Evidence = {
        id, investigation_id: ctx.investigationId, tool: name, source: name === 'query_metric' ? 'prometheus' : 'loki', args,
        rendered_query: query, window, status: output.status as Evidence['status'], error,
        result, stats: deriveStats(name, result), duration_ms: 0, created_at: toIsoUtcMs(now()),
      };
      await ctx.evidence.append(row);
      return result;
    };
    return (Object.keys(TOOL_INPUTS) as ToolName[]).map((name): LocalTool<unknown> => ({
      spec: { name, description: TOOL_DESCRIPTIONS[name], parameters: toApiJsonSchema(TOOL_INPUTS[name]) },
      args: z.unknown(),
      run: async (raw) => {
        if (seq >= ctx.budget.maxToolCalls || now() > ctx.budget.deadline) {
          return append(name, raw, { status: 'budget_exhausted', error: 'budget_exhausted' }, 'budget_exhausted', null, null);
        }
        const checked = CHECKED[name].safeParse(raw);
        if (!checked.success) {
          const reason = `invalid_input: ${checked.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 300);
          return append(name, raw, { status: 'error', error: reason }, reason, null, null);
        }
        executed++;
        const out = fixtureOutput(name, checked.data);
        return append(name, checked.data, out, null, out.window as Evidence['window'], renderedQuery(name, checked.data, ctx.incident.service));
      },
    }));
  };
  return { create, contexts, executed: () => executed };
}
