import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { METRIC_TEMPLATES } from '@traceops/contracts';
import { DEFAULT_RULES_PATH, loadRuleConfig, parseRuleConfig } from '../../src/detector/config.ts';

describe('config/rules.yaml', () => {
  const cfg = loadRuleConfig();
  it('validates against RuleConfig and matches detection.md §2', () => {
    expect(cfg.evaluation).toEqual({ interval_s: 15, fire_after: 2, resolve_after: 4, query_timeout_s: 5, reopen_window_s: 300 });
    expect(cfg.rules.map((r) => [r.id, r.service, r.group, r.query, r.op, r.threshold])).toEqual([
      ['http-latency-p95', 'demo-service', 'http-slo', 'latency_p95', '>', 1.0],
      ['http-error-ratio', 'demo-service', 'http-slo', 'error_ratio_5xx', '>', 0.05],
    ]);
  });
  it('only uses symptom templates that exist', () => {
    for (const r of cfg.rules) expect(METRIC_TEMPLATES).toHaveProperty(r.query);
  });

  const yaml = readFileSync(DEFAULT_RULES_PATH, 'utf8');
  it.each([
    ['a cause-based query (pool_used)', yaml.replace('query: latency_p95', 'query: pool_used')],
    ['an interval other than 15 s', yaml.replace('interval_s: 15', 'interval_s: 10')],
    ['an unknown key', yaml.replace('threshold: 1.0', 'threshold: 1.0\n    severity: high')],
    ['no rules', 'rules: []\nevaluation: {interval_s: 15, fire_after: 2, resolve_after: 4, query_timeout_s: 5, reopen_window_s: 300}'],
  ])('rejects %s', (_n, text) => expect(() => parseRuleConfig(text)).toThrow());
});
