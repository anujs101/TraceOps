import { LLM_DEFAULTS } from '@traceops/contracts';
import { SecretString } from '../groq/config.ts';

export const DEFAULT_DEEPSEEK_MODEL = LLM_DEFAULTS.deepseek.model;
export const DEFAULT_DEEPSEEK_BASE_URL = LLM_DEFAULTS.deepseek.baseUrl;
/** Strict tool schemas are a DeepSeek Beta feature, served only under /beta (api-docs.deepseek.com, Tool Calls guide). */
export const DEEPSEEK_BETA_PATH = '/beta';

export type DeepSeekConfig = {
  apiKey: SecretString;
  /** API host, as configured (no path). */
  baseUrl: string;
  model: string;
  timeoutMs: number;
};

/**
 * Contracts v1.2 environment.md §4. The key is read here and nowhere else.
 * DEEPSEEK_BASE_URL is the host only; the adapter appends /beta itself (strict mode needs it),
 * so a value already ending in /beta or /v1 is rejected rather than silently doubled.
 */
export function loadDeepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set');
  const baseUrl = (env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new Error('DEEPSEEK_BASE_URL is not a valid URL'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error('DEEPSEEK_BASE_URL must use https');
  if (/\/(beta|v1)$/.test(u.pathname)) throw new Error('DEEPSEEK_BASE_URL must be the API host (e.g. https://api.deepseek.com); the adapter adds /beta');
  const timeoutMs = Number(env.DEEPSEEK_TIMEOUT_MS ?? LLM_DEFAULTS.deepseek.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('DEEPSEEK_TIMEOUT_MS must be a positive integer');
  return { apiKey: new SecretString(key), baseUrl, model: env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL, timeoutMs };
}
