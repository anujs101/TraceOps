import { inspect } from 'node:util';

export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';

/** Holds the key without ever exposing it through logging, JSON or util.inspect. */
export class SecretString {
  readonly #value: string;
  constructor(value: string) { this.#value = value; }
  reveal(): string { return this.#value; }
  toString() { return '[REDACTED]'; }
  toJSON() { return '[REDACTED]'; }
  [inspect.custom]() { return '[REDACTED]'; }
}

export type GroqConfig = {
  apiKey: SecretString;
  model: string;
  timeoutMs: number;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
};

export function loadGroqConfig(env: NodeJS.ProcessEnv = process.env): GroqConfig {
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('GROQ_API_KEY is not set');
  const effort = env.GROQ_REASONING_EFFORT;
  return {
    apiKey: new SecretString(key),
    model: env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
    timeoutMs: Number(env.GROQ_TIMEOUT_MS ?? 30_000),
    reasoningEffort: effort === 'low' || effort === 'medium' || effort === 'high' ? effort : null,
  };
}
