import type { z } from 'zod';
import type { ChatResult, LlmMessage, LlmProvider, ToolCall, ToolSpec } from './types.ts';

/**
 * A tool the APPLICATION executes. The model only ever sees `spec` and the
 * string this handler returns; it never receives credentials, URLs, or a way
 * to reach Prometheus/Loki/shell directly.
 */
export type LocalTool<A = unknown> = {
  spec: ToolSpec;
  /** Server-side validation of model-supplied arguments (may be stricter than spec.parameters). */
  args: z.ZodType<A>;
  run: (args: A, ctx: { signal?: AbortSignal }) => Promise<unknown>;
};

export type ToolRun = {
  callId: string;
  name: string;
  status: 'ok' | 'invalid_args' | 'unknown_tool' | 'tool_error' | 'budget_exhausted';
  rawArguments: string;
  result: unknown;
};

export type ToolLoopResult = {
  finalText: string | null;
  stopReason: ChatResult['stopReason'];
  messages: LlmMessage[];
  toolRuns: ToolRun[];
  turns: number;
};

export type ToolLoopOptions = {
  stage: string;
  maxToolCalls: number;
  maxTurns: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** llm_calls trace: turn numbers start at firstTurn (default 1). */
  trace?: { investigationId: string; firstTurn?: number };
  /** Wraps each provider call (e.g. withRetry). */
  call?: <T>(fn: () => Promise<T>) => Promise<T>;
};

/** Wrap tool output as data, never instructions (Contracts v1, tools.md §1). */
export function wrapToolData(callId: string, payload: unknown): string {
  return `<tool_data call_id="${callId}">${JSON.stringify(payload)}</tool_data>`;
}

export async function runToolLoop(provider: LlmProvider, initial: LlmMessage[], tools: LocalTool<any>[], opts: ToolLoopOptions): Promise<ToolLoopResult> {
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const messages = [...initial];
  const toolRuns: ToolRun[] = [];
  const call = opts.call ?? ((fn) => fn());

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    const trace = opts.trace ? { investigationId: opts.trace.investigationId, turn: (opts.trace.firstTurn ?? 1) + turn - 1 } : undefined;
    const res = await call(() => provider.chat({ stage: opts.stage, trace, messages, tools: tools.map((t) => t.spec), maxOutputTokens: opts.maxOutputTokens, signal: opts.signal }));
    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
    if (res.toolCalls.length === 0) return { finalText: res.content, stopReason: res.stopReason, messages, toolRuns, turns: turn };

    for (const tc of res.toolCalls) {
      const run = await executeOne(tc, byName, toolRuns.length >= opts.maxToolCalls, opts.signal);
      toolRuns.push(run);
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: wrapToolData(tc.id, run.status === 'ok' ? run.result : { error: run.status, detail: run.result }) });
    }
  }
  return { finalText: null, stopReason: 'other', messages, toolRuns, turns: opts.maxTurns };
}

async function executeOne(tc: ToolCall, byName: Map<string, LocalTool<any>>, overBudget: boolean, signal?: AbortSignal): Promise<ToolRun> {
  const base = { callId: tc.id, name: tc.name, rawArguments: tc.argumentsJson };
  if (overBudget) return { ...base, status: 'budget_exhausted', result: 'tool budget exhausted; write your conclusion now' };
  const tool = byName.get(tc.name);
  if (!tool) return { ...base, status: 'unknown_tool', result: `no tool named ${JSON.stringify(tc.name).slice(0, 80)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(tc.argumentsJson || '{}');
  } catch {
    // A tool whose `args` accepts raw input (the investigator wraps tools with z.unknown()) gets
    // the raw string, so its own run() records the invalid_input evidence row (tools.md §1:
    // every call, including rejected ones, becomes an evidence row). Otherwise refuse here.
    if (!tool.args.safeParse(tc.argumentsJson).success) return { ...base, status: 'invalid_args', result: 'arguments are not valid JSON' };
    parsed = tc.argumentsJson;
  }
  const checked = tool.args.safeParse(parsed);
  if (!checked.success) return { ...base, status: 'invalid_args', result: checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300) };
  try {
    return { ...base, status: 'ok', result: await tool.run(checked.data, { signal }) };
  } catch (e) {
    return { ...base, status: 'tool_error', result: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}
