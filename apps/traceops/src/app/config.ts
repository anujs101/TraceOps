/**
 * Process configuration for the TraceOps entry point, read once from env (environment.md §4).
 * LLM variables are read by the LLM layer itself (createLlmProvider); only LLM_PROVIDER is
 * checked here so a bad value fails at startup, before anything else runs.
 */
import { PORTS, RuleConfig } from '@traceops/contracts';
import { selectedProvider } from '../llm/index.ts';
import { loadRuleConfig } from '../detector/config.ts';

export type AppConfig = {
  databaseUrl: string;
  prometheusUrl: string;
  lokiUrl: string;
  provider: ReturnType<typeof selectedProvider>;
  rules: RuleConfig;
  /** set when TRACEOPS_REOPEN_WINDOW_S overrides the contract value (evaluation only) */
  reopenWindowOverride: number | null;
  apiPort: number;
};

const DEFAULT_DB = `postgres://traceops:traceops@localhost:${PORTS.postgres}/traceops`;

function httpUrl(name: string, v: string): string {
  let u: URL;
  try { u = new URL(v); } catch { throw new Error(`${name} is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be http(s)`);
  return v.replace(/\/+$/, '');
}

/**
 * TRACEOPS_REOPEN_WINDOW_S: evaluation-only override of detection.md's reopen_window_s.
 * Unset → the contract value from config/rules.yaml stays. The result is re-validated with RuleConfig.
 */
export function applyReopenOverride(rules: RuleConfig, raw: string | undefined): { rules: RuleConfig; override: number | null } {
  if (raw === undefined || raw.trim() === '') return { rules, override: null };
  if (!/^\d+$/.test(raw.trim())) throw new Error('TRACEOPS_REOPEN_WINDOW_S must be a non-negative integer (seconds)');
  const n = Number(raw.trim());
  return { rules: RuleConfig.parse({ ...rules, evaluation: { ...rules.evaluation, reopen_window_s: n } }), override: n };
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env, rules: RuleConfig = loadRuleConfig()): AppConfig {
  const { rules: effective, override } = applyReopenOverride(rules, env.TRACEOPS_REOPEN_WINDOW_S);
  return {
    databaseUrl: env.TRACEOPS_DATABASE_URL?.trim() || DEFAULT_DB,
    prometheusUrl: httpUrl('PROMETHEUS_URL', env.PROMETHEUS_URL?.trim() || `http://localhost:${PORTS.prometheus}`),
    lokiUrl: httpUrl('LOKI_URL', env.LOKI_URL?.trim() || `http://localhost:${PORTS.loki}`),
    provider: selectedProvider(env),
    rules: effective,
    reopenWindowOverride: override,
    apiPort: PORTS.traceopsApi,
  };
}

/** A database URL safe to log: password removed. */
export function redactDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<unparseable database url>';
  }
}
