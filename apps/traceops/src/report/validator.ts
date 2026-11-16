import {
  Report, findUnboundQuantities, placeholders, resolveField, valueMatches,
  type Evidence, type Report as ReportT, type ValidationResult,
} from '@traceops/contracts';

/**
 * Deterministic report validator: rules V0–V8 of Contracts v1
 * (docs/contracts/evidence-and-report.md §4). No LLM involved.
 */
type Issue = ValidationResult['violations'][number];

export function validateReport(candidate: unknown, evidence: Evidence[]): ValidationResult {
  const violations: Issue[] = [];
  const warnings: Issue[] = [];
  const v = (rule: string, path: string, message: string) => violations.push({ rule, path, message });
  const w = (rule: string, path: string, message: string) => warnings.push({ rule, path, message });

  // V0: structure (full checked schema, never the provider-facing one)
  const parsed = Report.safeParse(candidate);
  if (!parsed.success) {
    for (const i of parsed.error.issues) v('V0', i.path.join('.'), i.message);
    return { passed: false, violations, warnings };
  }
  const r: ReportT = parsed.data;
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const okEvidence = (id: string) => ev.get(id)?.status === 'ok';
  const allowed = allowedLiterals(evidence);

  // V1 + V2 + V3 (observations)
  const valueKeys = new Map<string, string>(); // key -> observation id
  r.observations.forEach((o, i) => {
    const p = `observations.${i}`;
    for (const id of o.evidence_ids) if (!okEvidence(id)) v('V1', `${p}.evidence_ids`, `${id} is unknown or not status ok`);
    o.values.forEach((val, j) => {
      valueKeys.set(val.key, o.id);
      if (!okEvidence(val.evidence_id)) { v('V1', `${p}.values.${j}`, `${val.evidence_id} is unknown or not status ok`); return; }
      if (!o.evidence_ids.includes(val.evidence_id)) v('V1', `${p}.values.${j}`, `${val.evidence_id} not in this observation's evidence_ids`);
      const actual = resolveField(ev.get(val.evidence_id)!, val.field);
      if (actual === undefined) v('V2', `${p}.values.${j}`, `field "${val.field}" does not exist on ${val.evidence_id}`);
      else if (!valueMatches(val.value, actual)) v('V2', `${p}.values.${j}`, `value ${val.value} does not match ${val.evidence_id}.${val.field} = ${actual}`);
    });
    const bound = new Set(o.values.map((x) => x.key));
    const used = new Set(placeholders(o.statement));
    for (const k of used) if (!bound.has(k)) v('V3', `${p}.statement`, `placeholder {${k}} has no value`);
    for (const k of bound) if (!used.has(k)) v('V3', `${p}.values`, `value key "${k}" is not used in the statement`);
    quantities(o.statement, `${p}.statement`);
  });

  // V3 (other prose) + V4 + V5
  const obs = new Map(r.observations.map((o) => [o.id, o]));
  r.hypotheses.forEach((h, i) => {
    const p = `hypotheses.${i}`;
    for (const id of [...h.supporting_observation_ids, ...h.contradicting_observation_ids]) if (!obs.has(id)) v('V4', p, `unknown observation ${id}`);
    const cited = new Set([...h.supporting_observation_ids, ...h.contradicting_observation_ids]);
    for (const k of placeholders(h.statement)) {
      const owner = valueKeys.get(k);
      if (!owner) v('V3', `${p}.statement`, `placeholder {${k}} has no value`);
      else if (!cited.has(owner)) v('V3', `${p}.statement`, `placeholder {${k}} belongs to ${owner}, which this hypothesis does not cite`);
    }
    quantities(h.statement, `${p}.statement`);
    if (h.confidence === 'high') {
      const sources = new Set(h.supporting_observation_ids.flatMap((id) => obs.get(id)?.evidence_ids ?? []).map((id) => ev.get(id)?.source));
      if (!(sources.has('prometheus') && sources.has('loki'))) v('V5', `${p}.confidence`, 'high confidence requires supporting observations citing both prometheus and loki evidence');
    }
  });
  quantities(r.summary, 'summary');
  if (placeholders(r.summary).length) v('V3', 'summary', 'summary must not contain placeholders or quantities');

  // V6
  r.timeline.forEach((t, i) => {
    const p = `timeline.${i}`;
    quantities(t.event, `${p}.event`);
    if (t.evidence_ids.length === 0) v('V6', p, 'timeline event cites no evidence');
    for (const id of t.evidence_ids) if (!okEvidence(id)) v('V1', `${p}.evidence_ids`, `${id} is unknown or not status ok`);
    const at = Date.parse(t.at);
    const inWindow = evidence.some((e) => e.window && at >= Date.parse(e.window.start) && at <= Date.parse(e.window.end));
    if (!inWindow) v('V6', `${p}.at`, `${t.at} is outside every queried window`);
  });

  // V7
  if (r.status === 'probable_cause' && r.hypotheses.length === 0) v('V7', 'status', 'probable_cause requires at least one hypothesis');
  if (r.status === 'insufficient_evidence' && r.hypotheses.some((h) => h.confidence === 'high')) v('V7', 'status', 'insufficient_evidence cannot carry a high-confidence hypothesis');

  // V8
  const hyps = new Set(r.hypotheses.map((h) => h.id));
  r.recommendations.forEach((rec, i) => {
    if (!hyps.has(rec.hypothesis_id)) v('V8', `recommendations.${i}`, `unknown hypothesis ${rec.hypothesis_id}`);
    for (const f of findUnboundQuantities(`${rec.action} ${rec.rationale}`, allowed)) if (f.kind === 'unbound_quantity') w('W-rec', `recommendations.${i}`, `quantity "${f.token}" in a proposal`);
  });
  if (r.gaps.length === 0 && evidence.some((e) => e.status === 'error')) w('W-gaps', 'gaps', 'some evidence errored but gaps is empty');

  return { passed: violations.length === 0, violations, warnings };

  function quantities(text: string, path: string) {
    for (const f of findUnboundQuantities(text, allowed)) {
      if (f.kind === 'unbound_quantity') v('V3', path, `unbound quantity "${f.token}" — use a {key} placeholder bound in values`);
      else w('W-time', path, `time literal "${f.token}" — times belong in the timeline`);
    }
  }
}

/** Identifier-like literals present in evidence (status codes, service versions). */
export function allowedLiterals(evidence: Evidence[]): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown, key?: string): void => {
    if (Array.isArray(x)) return x.forEach((y) => walk(y, key));
    if (x && typeof x === 'object') { for (const [k, y] of Object.entries(x)) walk(y, k); return; }
    if ((key === 'status' || key === 'http_response_status_code') && (typeof x === 'number' || typeof x === 'string') && /^\d{3}$/.test(String(x))) out.add(String(x));
    if ((key === 'service_version' || key === 'service_versions') && typeof x === 'string') out.add(x);
  };
  for (const e of evidence) walk(e.result);
  return out;
}
