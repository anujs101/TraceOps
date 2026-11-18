import { inspect } from 'node:util';
import { LLM_DEFAULTS } from '@traceops/contracts';

export const DEFAULT_GROQ_MODEL = LLM_DEFAULTS.groq.model;
export const DEFAULT_GROQ_BASE_URL = LLM_DEFAULTS.groq.baseUrl;

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
  baseUrl: string;
  model: string;
  timeoutMs: number;
  reasoningEffort: 'low' | 'medium' | 'high' | null;
};

/**
 * Contracts v1.1 environment.md §4. The key is read here and nowhere else.
 * GROQ_BASE_URL is the API host; groq-sdk appends /openai/v1/... itself, so an
 * OpenAI-style base URL ending in /openai/v1 is rejected (it would double the path).
 */
export function loadGroqConfig(env: NodeJS.ProcessEnv = process.env): GroqConfig {
  const key = env.GROQ_API_KEY?.trim();
  if (!key) throw new Error('GROQ_API_KEY is not set');
  const baseUrl = (env.GROQ_BASE_URL?.trim() || DEFAULT_GROQ_BASE_URL).replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new Error('GROQ_BASE_URL is not a valid URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('GROQ_BASE_URL must use https');
  if (/\/openai\/v1$/.test(u.pathname)) throw new Error('GROQ_BASE_URL must be the API host (e.g. https://api.groq.com); the SDK adds /openai/v1');
  const timeoutMs = Number(env.GROQ_TIMEOUT_MS ?? LLM_DEFAULTS.groq.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('GROQ_TIMEOUT_MS must be a positive integer');
  const effort = env.GROQ_REASONING_EFFORT?.trim();
  if (effort && !['low', 'medium', 'high'].includes(effort)) throw new Error('GROQ_REASONING_EFFORT must be low, medium or high');
  return {
    apiKey: new SecretString(key),
    baseUrl,
    model: env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
    timeoutMs,
    reasoningEffort: (effort as GroqConfig['reasoningEffort']) || null,
  };
}
