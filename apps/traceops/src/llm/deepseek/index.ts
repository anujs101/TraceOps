import { RecordingProvider, type CallRecorder } from '../recorder.ts';
import type { LlmProvider } from '../types.ts';
import { createDeepSeekClient, DeepSeekProvider } from './adapter.ts';
import { loadDeepSeekConfig } from './config.ts';

export { DeepSeekProvider, createDeepSeekClient, mapDeepSeekError, SUBMIT_REPORT_TOOL } from './adapter.ts';
export { loadDeepSeekConfig, type DeepSeekConfig } from './config.ts';
export { deepseekStrictProblems, toDeepSeekWireSchema } from './schema.ts';

/** One-call factory for the selector in ../index.ts (`case 'deepseek'`). */
export function createDeepSeekProvider(recorder: CallRecorder, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const cfg = loadDeepSeekConfig(env);
  return new RecordingProvider(new DeepSeekProvider(createDeepSeekClient(cfg), cfg), recorder);
}
