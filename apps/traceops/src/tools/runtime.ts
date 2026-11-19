import { z } from 'zod';
import {
  TOOL_SOURCE, deriveStats, deriveWindows, toApiJsonSchema, toIsoUtcMs,
  type Evidence, type InvestigationWindows, type ToolName,
} from '@traceops/contracts';
import type { LocalTool } from '../llm/tool-loop.ts';
import type { ToolContext } from '../seams.ts';
import type { BackendDeps } from './backend/index.ts';
import { cleanString } from './redact.ts';
import { invalidInput } from './errors.ts';
import { resolveWindow, type Window, type WindowArg } from './render.ts';

export type Executed = {
  /** Complete model-facing output (evidence_id, status, error included). */
  output: Record<string, unknown> & { status: 'ok' | 'empty' | 'error' };
  /** The caller's AbortSignal fired: record the row, then throw. */
  aborted?: boolean;
};

export type ExecEnv = { ctx: ToolContext; deps: BackendDeps; id: string; service: string };

/** One of the four tools. Everything tool-specific lives here; the pipeline lives in `createRuntime`. */
export type ToolDef = {
  name: ToolName;
  description: string;
  /** Provider-facing schema (no constraints). */
  input: z.ZodType;
  /** Server-side schema with the limits. */
  checked: z.ZodType<{ window: WindowArg }>;
  /** Build the query. May throw (invalid service name). Nothing is sent before this succeeds. */
  render(args: any, window: Window, service: string): string;
  execute(args: any, window: Window, query: string, env: ExecEnv): Promise<Executed>;
};

/** What the model sees when nothing was sent (invalid input, budget, internal failure). */
const early = (id: string, status: 'error' | 'budget_exhausted', error: string) => ({ evidence_id: id, status, error });

function reason(err: z.ZodError): string {
  const parts: string[] = [];
  for (const i of err.issues) {
    const path = i.path.join('.') || '(input)';
    const inner = (i as { errors?: { message: string }[][] }).errors;
    const msg = i.code === 'invalid_union' && inner ? [...new Set(inner.flat().map((x) => x.message))].join(' / ') : i.message;
    parts.push(`${path}: ${msg}`);
  }
  return parts.join('; ');
}

export function createRuntime(ctx: ToolContext, baseDeps: Pick<BackendDeps, 'fetch' | 'timeoutMs'> = {}) {
  const windows: InvestigationWindows = deriveWindows(ctx.incident.started_at, ctx.investigationStart);
  const service = ctx.incident.service;
  let calls = 0;

  async function run(def: ToolDef, raw: unknown, callSignal?: AbortSignal): Promise<unknown> {
    // Numbered synchronously, so parallel calls get ids in request order (evidence-and-report.md §1).
    const n = ++calls;
    const id = `ev_${n}`;
    const t0 = Date.now();

    const record = async (row: Pick<Evidence, 'args' | 'rendered_query' | 'window' | 'status' | 'error' | 'result' | 'stats'>) => {
      await ctx.evidence.append({
        id, investigation_id: ctx.investigationId, tool: def.name, source: TOOL_SOURCE[def.name],
        ...row, duration_ms: Math.max(0, Math.round(Date.now() - t0)), created_at: toIsoUtcMs(new Date()),
      });
      return row.result;
    };
    const rejected = (args: unknown, window: Window | null, status: 'error' | 'budget_exhausted', error: string) =>
      record({ args, rendered_query: null, window, status, error, result: early(id, status, error), stats: {} });

    // 1. budget (tools.md §1)
    if (n > ctx.budget.maxToolCalls || Date.now() > ctx.budget.deadline) {
      return rejected(raw, null, 'budget_exhausted', 'budget_exhausted: the tool budget is used up; write your report now');
    }

    // 2. *Checked schema: invalid input is recorded raw and nothing is sent
    const parsed = def.checked.safeParse(raw);
    if (!parsed.success) return rejected(raw, null, 'error', invalidInput(reason(parsed.error)));
    const args = parsed.data as { window: WindowArg };

    // 3. window → resolved, inside `allowed`
    const w = resolveWindow(args.window, windows);
    if (!w.ok) return rejected(raw, null, 'error', invalidInput(w.reason));
    const resolvedArgs = { ...args, window: w.window };

    // 4. render
    let query: string;
    try {
      query = def.render(args, w.window, service);
    } catch (e) {
      return rejected(resolvedArgs, w.window, 'error', cleanString(`internal_error: ${e instanceof Error ? e.message : 'render failed'}`, 300));
    }

    // 5. execute against the backend
    const signals = [ctx.signal, callSignal].filter((s): s is AbortSignal => !!s);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    let output: Executed['output'];
    let aborted: boolean | undefined;
    let stats: Record<string, number>;
    try {
      ({ output, aborted } = await def.execute(args, w.window, query, {
        ctx, deps: { ...baseDeps, signal, deadline: ctx.budget.deadline }, id, service,
      }));
      // 6. stats come from deriveStats, never from the model
      stats = deriveStats(def.name, output);
    } catch (e) {
      // An internal failure must still leave exactly one evidence row (no ev_N gaps).
      const msg = cleanString(`internal_error: ${e instanceof Error ? e.message : 'tool failed'}`, 300);
      const result = await record({
        args: resolvedArgs, rendered_query: query, window: w.window, status: 'error', error: msg,
        result: early(id, 'error', msg), stats: {},
      });
      if (signal?.aborted) throw new Error('aborted');
      return result;
    }

    // 7. one evidence row
    const error = typeof output.error === 'string' ? output.error.slice(0, 300) : null;
    const result = await record({
      args: resolvedArgs, rendered_query: query, window: w.window, status: output.status, error, result: output, stats,
    });
    if (aborted) throw new Error('aborted');
    return result;
  }

  function toLocalTool(def: ToolDef): LocalTool<unknown> {
    return {
      spec: { name: def.name, description: def.description, parameters: toApiJsonSchema(def.input) as any },
      // Deliberately permissive: a stricter schema here would make the tool loop reject bad input
      // before `run`, and then no evidence row would exist. `run` applies the *Checked schema.
      args: z.unknown(),
      run: (args, { signal }) => run(def, args, signal),
    };
  }

  return { toLocalTool, windows };
}
