import { z } from 'zod';
import { ISO_UTC_MS } from './time.ts';

export const CATEGORIES = ['db_pool_exhaustion', 'cpu_saturation', 'memory_pressure', 'dependency_latency', 'other'] as const;

/**
 * ReportApi: the schema sent as the provider's strict structured-output schema
 * (Groq: response_format.json_schema, strict). It uses only features every
 * enabled provider's strict mode supports (no min/max/length/pattern
 * constraints, every property required, additionalProperties:false).
 * Report (below) adds the constraints the API cannot enforce.
 *
 * Numbers in prose are written as placeholders `{key}` that must be bound by a
 * `values` entry; the UI renders the bound value. See quantities.ts.
 */
export const ReportApi = z.object({
  status: z.enum(['probable_cause', 'insufficient_evidence']),
  summary: z.string(),
  observations: z.array(z.object({
    id: z.string(),
    statement: z.string(),
    evidence_ids: z.array(z.string()),
    values: z.array(z.object({
      key: z.string(), evidence_id: z.string(), field: z.string(), value: z.number(),
    }).strict()),
  }).strict()),
  hypotheses: z.array(z.object({
    id: z.string(),
    category: z.enum(CATEGORIES),
    statement: z.string(),
    confidence: z.enum(['low', 'medium', 'high']),
    supporting_observation_ids: z.array(z.string()),
    contradicting_observation_ids: z.array(z.string()),
  }).strict()),
  timeline: z.array(z.object({ at: z.string(), event: z.string(), evidence_ids: z.array(z.string()) }).strict()),
  recommendations: z.array(z.object({
    action: z.string(), rationale: z.string(), hypothesis_id: z.string(), risk: z.enum(['low', 'medium', 'high']),
  }).strict()),
  gaps: z.array(z.string()),
}).strict();
export type Report = z.infer<typeof ReportApi>;

/** Structural constraints the API cannot enforce (run before semantic validation V1–V8). */
export const Report = ReportApi.superRefine((r, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (r.summary.length > 600) issue(['summary'], 'summary must be <= 600 chars');
  const ids = new Set<string>();
  r.observations.forEach((o, i) => {
    if (!/^obs_[1-9]\d*$/.test(o.id)) issue(['observations', i, 'id'], 'id must be obs_N');
    if (ids.has(o.id)) issue(['observations', i, 'id'], 'duplicate id');
    ids.add(o.id);
    if (o.evidence_ids.length === 0) issue(['observations', i, 'evidence_ids'], 'must cite >= 1 evidence');
  });
  const keys = new Set<string>();
  r.observations.forEach((o, i) => o.values.forEach((v, j) => {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(v.key)) issue(['observations', i, 'values', j, 'key'], 'key must match [a-z][a-z0-9_]*');
    if (keys.has(v.key)) issue(['observations', i, 'values', j, 'key'], 'value keys must be unique across the report');
    keys.add(v.key);
  }));
  r.hypotheses.forEach((h, i) => {
    if (!/^hyp_[1-9]\d*$/.test(h.id)) issue(['hypotheses', i, 'id'], 'id must be hyp_N');
    if (h.supporting_observation_ids.length === 0) issue(['hypotheses', i, 'supporting_observation_ids'], 'must cite >= 1 observation');
  });
  r.timeline.forEach((t, i) => { if (!ISO_UTC_MS.test(t.at)) issue(['timeline', i, 'at'], 'must be ISO 8601 UTC with ms'); });
});

export type ValidationResult = {
  passed: boolean;
  violations: Array<{ rule: string; path: string; message: string }>;
  warnings: Array<{ rule: string; path: string; message: string }>;
};
