import { z } from 'zod';
import { IsoUtcMs } from './time.ts';

export const RuleConfig = z.object({
  rules: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    service: z.string(),
    group: z.string().regex(/^[a-z0-9-]+$/), // incident group: rules sharing a group share one incident
    query: z.enum(['latency_p95', 'error_ratio_5xx']), // symptom templates only
    op: z.enum(['>', '<']),
    threshold: z.number(),
  }).strict()).min(1),
  evaluation: z.object({
    interval_s: z.literal(15),
    fire_after: z.number().int().min(1),
    resolve_after: z.number().int().min(1),
    query_timeout_s: z.number().positive(),
    reopen_window_s: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type RuleConfig = z.infer<typeof RuleConfig>;

export const Incident = z.object({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/), // sha256(service + ":" + group)
  service: z.string(),
  group: z.string(),
  status: z.enum(['open', 'resolved']),
  severity: z.enum(['critical', 'warning']),
  started_at: IsoUtcMs,
  detected_at: IsoUtcMs,
  resolved_at: IsoUtcMs.nullable(),
  reopen_count: z.number().int().nonnegative(),
  trigger: z.array(z.object({
    rule_id: z.string(), query: z.string(), threshold: z.number(), observed: z.number(), at: IsoUtcMs,
  }).strict()).min(1),
}).strict();
export type Incident = z.infer<typeof Incident>;

export const InvestigationWindows = z.object({
  incident: z.object({ start: IsoUtcMs, end: IsoUtcMs }).strict(),
  baseline: z.object({ start: IsoUtcMs, end: IsoUtcMs }).strict(),
  allowed: z.object({ start: IsoUtcMs, end: IsoUtcMs }).strict(),
}).strict();
export type InvestigationWindows = z.infer<typeof InvestigationWindows>;

const MIN = 60_000;
/** detection.md §6, as executable spec. */
export function deriveWindows(startedAt: string, investigationStart: string): InvestigationWindows {
  const s = Date.parse(startedAt), now = Date.parse(investigationStart);
  const incStart = s - 2 * MIN;
  const len = Math.min(now - incStart, 15 * MIN);
  const iso = (t: number) => new Date(t).toISOString();
  return {
    incident: { start: iso(incStart), end: iso(now) },
    baseline: { start: iso(incStart - len), end: iso(incStart) },
    allowed: { start: iso(s - 60 * MIN), end: iso(now) },
  };
}
