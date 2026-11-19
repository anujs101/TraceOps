import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { RuleConfig } from '@traceops/contracts';

export const DEFAULT_RULES_PATH = fileURLToPath(new URL('../../config/rules.yaml', import.meta.url));

/** Parse and validate rules.yaml with the frozen RuleConfig schema. Throws with the zod issues on invalid input. */
export function parseRuleConfig(yamlText: string): RuleConfig {
  return RuleConfig.parse(parse(yamlText));
}

export function loadRuleConfig(path: string = DEFAULT_RULES_PATH): RuleConfig {
  return parseRuleConfig(readFileSync(path, 'utf8'));
}
