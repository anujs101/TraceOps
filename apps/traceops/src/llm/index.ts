/**
 * The investigator's only entry point into the LLM layer (Contracts v1.1).
 * Provider SDKs are imported only inside their adapter directory (./groq/, ./deepseek/ since v1.2);
 * adding one touches only this selector, never investigator code.
 */
import { LLM_DEFAULTS, LLM_PROVIDERS, type LlmProviderName } from '@traceops/contracts';
import { createGroqClient, GroqProvider } from './groq/adapter.ts';
import { loadGroqConfig } from './groq/config.ts';
import { createDeepSeekProvider } from './deepseek/index.ts';
import { RecordingProvider, type CallRecorder } from './recorder.ts';
import type { LlmProvider } from './types.ts';

export * from './types.ts';
export { LlmError } from './errors.ts';
export { RecordingProvider, MemoryRecorder, toLlmCallRow, type CallRecorder, type LlmCallRecord } from './recorder.ts';
export { withRetry, DEFAULT_RETRY, type RetryPolicy } from './retry.ts';

export function selectedProvider(env: NodeJS.ProcessEnv = process.env): LlmProviderName {
  const p = (env.LLM_PROVIDER?.trim() || LLM_DEFAULTS.provider) as LlmProviderName;
  if (!(LLM_PROVIDERS as readonly string[]).includes(p)) throw new Error(`unsupported LLM_PROVIDER "${String(env.LLM_PROVIDER).slice(0, 40)}" (supported: ${LLM_PROVIDERS.join(', ')})`);
  return p;
}

/** Build the configured provider, wrapped so every attempt is recorded. */
export function createLlmProvider(recorder: CallRecorder, env: NodeJS.ProcessEnv = process.env): LlmProvider {
  switch (selectedProvider(env)) {
    case 'groq': {
      const cfg = loadGroqConfig(env);
      return new RecordingProvider(new GroqProvider(createGroqClient(cfg), cfg), recorder);
    }
    case 'deepseek':
      return createDeepSeekProvider(recorder, env);
  }
}
