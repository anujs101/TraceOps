import type { CreateTools, ToolContext } from '../seams.ts';
import type { BackendDeps } from './backend/index.ts';
import { logPatternsTool } from './log-patterns.ts';
import { logVolumeTool } from './log-volume.ts';
import { queryMetricTool } from './query-metric.ts';
import { createRuntime } from './runtime.ts';
import { searchLogsTool } from './search-logs.ts';

export { redact, truncate, cleanString } from './redact.ts';

/**
 * Same as `createTools` with an injectable transport; tests pass a fetch that replays
 * contract fixtures. Each call to the returned factory owns its own budget and numbering.
 */
export function createToolsWith(deps: Pick<BackendDeps, 'fetch' | 'timeoutMs'> = {}): CreateTools {
  return (ctx: ToolContext) => {
    const rt = createRuntime(ctx, deps);
    return [queryMetricTool, searchLogsTool, logPatternsTool, logVolumeTool].map(rt.toLocalTool);
  };
}

/** The seam (src/seams.ts): the four investigator tools, bound to one investigation. */
export const createTools: CreateTools = createToolsWith();
