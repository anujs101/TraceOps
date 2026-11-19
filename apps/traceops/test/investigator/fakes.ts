/**
 * Test doubles for the investigator. Nothing here talks to a network.
 *  - ScriptedProvider: an LlmProvider that replays a script of chat/structured responses.
 *  - fixtureCreateTools: a CreateTools whose outputs come from the REAL S1 fixtures
 *    (via scripts/lib/fixture-evidence.ts) and that follows the seams.ts contract:
 *    validate *Checked inside run, one evidence row per call (also invalid input and
 *    budget exhaustion).
 */
import {
  deriveStats, LogPatternsChecked, LogVolumeChecked, QueryMetricChecked, SearchLogsChecked, TOOL_INPUTS, toApiJsonSchema, toIsoUtcMs,
  type Evidence, type Incident, type ToolName,
} from '@traceops/contracts';
import type { ChatRequest, ChatResult, LlmProvider, StructuredRequest, StructuredResult, ToolCall } from '../../src/llm/index.ts';
import { LlmError } from '../../src/llm/index.ts';
import type { LocalTool } from '../../src/llm/tool-loop.ts';
import type { CreateTools, ToolContext } from '../../src/seams.ts';
import { TOOL_DESCRIPTIONS } from '../../src/investigator/prompt.ts';
import { logPatternsOutput, logVolumeOutput, manifest, queryMetricOutput, searchLogsOutput } from '../../scripts/lib/fixture-evidence.ts';

export const INV_ID = '00000000-0000-4000-8000-0000000000d1';
export const INVESTIGATION_START = manifest.end as string;

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

// ── scripted provider ──────────────────────────────────────────────────────

export type ChatStep = { kind: 'chat'; toolCalls?: Array<{ name: string; args: unknown }>; content?: string } | { kind: 'chat_error'; error: LlmError };
export type StructuredStep = { kind: 'structured'; value: unknown } | { kind: 'structured_error'; error: LlmError };
export type Step = ChatStep | StructuredStep;

const meta = (model: string) => ({ provider: 'groq', model, requestId: 'req_fake', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, providerTimings: null });

export class ScriptedProvider implements LlmProvider {
  /** A provider name from LLM_PROVIDERS so recorded calls map onto llm_calls rows; no network is involved. */
  readonly name = 'groq';
  readonly model = 'fake-model';
  readonly requests: Array<{ kind: 'chat' | 'structured'; stage: string; turn: number | undefined; req: ChatRequest | StructuredRequest }> = [];
  private n = 0;
  private readonly steps: Step[];
  /** `loopChat`: returned for every chat request once the scripted chat steps are used up (budget tests). */
  constructor(steps: Step[], private readonly opts: { loopChat?: ChatStep } = {}) { this.steps = [...steps]; }

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push({ kind: 'chat', stage: req.stage, turn: req.trace?.turn, req: structuredClone(req) });
    const head = this.steps[0];
    const step = head && (head.kind === 'chat' || head.kind === 'chat_error') ? this.steps.shift() as ChatStep : this.opts.loopChat;
    if (!step) throw new Error(`fake: expected a chat step, got ${head?.kind ?? 'nothing'}`);
    if (step.kind === 'chat_error') throw step.error;
    const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((c) => ({ id: `call_${++this.n}`, name: c.name, argumentsJson: JSON.stringify(c.args) }));
    return { content: step.content ?? null, toolCalls, stopReason: toolCalls.length ? 'tool_calls' : 'end', meta: meta(this.model) };
  }

  async structured(req: StructuredRequest): Promise<StructuredResult> {
    this.requests.push({ kind: 'structured', stage: req.stage, turn: req.trace?.turn, req: structuredClone(req) });
    const step = this.steps.shift();
    if (!step || (step.kind !== 'structured' && step.kind !== 'structured_error')) throw new Error(`fake: expected a structured step, got ${step?.kind ?? 'nothing'}`);
    if (step.kind === 'structured_error') throw step.error;
    return { value: step.value, rawText: JSON.stringify(step.value), meta: meta(this.model) };
  }
}

// ── fixture-backed CreateTools ─────────────────────────────────────────────

const CHECKED = { query_metric: QueryMetricChecked, search_logs: SearchLogsChecked, log_patterns: LogPatternsChecked, log_volume: LogVolumeChecked } as const;

function fixtureOutput(name: ToolName, a: any): Record<string, unknown> {
  switch (name) {
    case 'query_metric': return queryMetricOutput(a.metric);
    case 'search_logs': return searchLogsOutput(Math.min(a.limit ?? 5, 5));
    case 'log_patterns': return logPatternsOutput();
    case 'log_volume': return logVolumeOutput();
  }
}

export type FakeToolsHandle = { create: CreateTools; contexts: ToolContext[]; executed: () => number };

export function fixtureCreateTools(opts: { now?: () => number } = {}): FakeToolsHandle {
  const now = opts.now ?? Date.now;
  const contexts: ToolContext[] = [];
  let executed = 0;
  const create: CreateTools = (ctx) => {
    contexts.push(ctx);
    let seq = 0;
    const append = async (name: ToolName, args: unknown, output: Record<string, unknown>, error: string | null, window: Evidence['window']) => {
      const id = `ev_${++seq}`;
      const result = { evidence_id: id, ...output };
      const row: Evidence = {
        id, investigation_id: ctx.investigationId, tool: name, source: name === 'query_metric' ? 'prometheus' : 'loki', args,
        rendered_query: window ? `fixture:${name}` : null, window, status: output.status as Evidence['status'], error,
        result, stats: deriveStats(name, result), duration_ms: 0, created_at: toIsoUtcMs(now()),
      };
      await ctx.evidence.append(row);
      return result;
    };
    return (Object.keys(TOOL_INPUTS) as ToolName[]).map((name): LocalTool<any> => ({
      spec: { name, description: TOOL_DESCRIPTIONS[name], parameters: toApiJsonSchema(TOOL_INPUTS[name]) },
      args: CHECKED[name],
      run: async (raw) => {
        if (seq >= ctx.budget.maxToolCalls || now() > ctx.budget.deadline) {
          return append(name, raw, { status: 'budget_exhausted', error: 'budget_exhausted' }, 'budget_exhausted', null);
        }
        const checked = CHECKED[name].safeParse(raw);
        if (!checked.success) {
          const reason = `invalid_input: ${checked.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 300);
          return append(name, raw, { status: 'error', error: reason }, reason, null);
        }
        executed++;
        const out = fixtureOutput(name, checked.data);
        return append(name, checked.data, out, null, out.window as Evidence['window']);
      },
    }));
  };
  return { create, contexts, executed: () => executed };
}

/** In-memory sinks for evidence and reports. */
export function memorySinks() {
  const evidence: Evidence[] = [];
  const reports: import('../../src/report/generate.ts').ReportRow[] = [];
  return { evidence, reports, evidenceSink: { append: async (r: Evidence) => { evidence.push(r); } }, reportSink: { save: async (r: (typeof reports)[number]) => { reports.push(r); } } };
}
