# Contract: evidence, report and validator

**Status:** frozen v1 (2026-11-17) · **Executable source:** `packages/contracts/src/evidence.ts`, `report.ts`, `quantities.ts`
**Guarantee:** a report is shown as *validated* only if every claim cites stored evidence and every quantity is bound to a value that matches that evidence.

## 1. Evidence (one row per tool call; also the audit log)
```ts
type Evidence = {
  id: `ev_${n}`;               // sequential per investigation (parallel calls numbered in request order)
  investigation_id: uuid;
  tool: "query_metric" | "search_logs" | "log_patterns" | "log_volume";
  source: "prometheus" | "loki";
  args: unknown;               // checked args (windows resolved) — or the RAW input if invalid
  rendered_query: string | null;   // null if nothing was sent
  window: { start: IsoUtcMs; end: IsoUtcMs } | null;
  status: "ok" | "empty" | "error" | "budget_exhausted";
  error: string | null;        // ≤ 300 chars, e.g. "invalid_input: limit must be <= 50"
  result: unknown;             // exactly what the model saw (allowlisted + redacted)
  stats: Record<string, number>;   // flat, keys per tools.md §7, from deriveStats()
  duration_ms: number; created_at: IsoUtcMs;
};
```
Append-only. `result` and `stats` are computed by our code, never by the model.

## 2. Report
**Two layers.** `ReportApi` is sent as the provider's strict structured-output schema (Groq: `response_format.json_schema`, `strict: true`; v1.1 wording), in a request **separate from tool calling**. It contains only provider-supported constructs: every property required, no length/count/pattern constraints. `Report` adds the structural checks the API can't enforce: id formats, ≥1 citation, unique value keys, summary ≤ 600 chars, `timeline.at` is IsoUtcMs.

```ts
type Report = {
  status: "probable_cause" | "insufficient_evidence";
  summary: string;                         // no quantities (warning-free prose)
  observations: {
    id: `obs_${n}`;
    statement: string;                     // quantities ONLY as {key} placeholders
    evidence_ids: string[];                // ≥ 1
    values: { key: string; evidence_id: string; field: string; value: number }[];
  }[];
  hypotheses: {                            // ordered; [0] = top hypothesis
    id: `hyp_${n}`;
    category: "db_pool_exhaustion" | "cpu_saturation" | "memory_pressure" | "dependency_latency" | "other";
    statement: string;                     // may use {key} placeholders of observations it cites
    confidence: "low" | "medium" | "high";
    supporting_observation_ids: string[];  // ≥ 1
    contradicting_observation_ids: string[];
  }[];
  timeline: { at: IsoUtcMs; event: string; evidence_ids: string[] }[];
  recommendations: { action: string; rationale: string; hypothesis_id: string; risk: "low"|"medium"|"high" }[];
  gaps: string[];
};
```
Example: `"Connections in use rose to {used_max} of {pool_max}"` with `values: [{key:"used_max", evidence_id:"ev_1", field:"max", value:10}, …]`. The UI renders the bound values, and every rendered number links to its evidence.

## 3. Numeric grounding (designed not to be brittle)
Instead of scanning prose for digits, numbers are **structured data**:
1. **Quantities** go in `values` and appear in prose as `{key}`.
2. The validator only flags tokens that **read as quantities**: bare numbers (`10`, `0.47`, `21%`, `1,000`) and unit-suffixed numbers (`2.4s`, `950ms`, `3x`).
3. **Identifiers are never quantities:** `p95`, `p99`, `5xx`, `v1.0.1`, `1.0.1`, `ev_3`, `/orders`, `HTTP/1.1`, metric and label names.
4. **Context allowlist:** a bare integer that appears in the investigation's evidence as an identifier (HTTP status codes such as `500`/`409`, service versions) is allowed. So "HTTP 500 responses" passes when a 500 exists in the evidence, and "HTTP 503" fails if it doesn't.
5. **Clock times** (`18:03`, ISO) are not quantities. They produce a **warning** (times belong in the timeline), not a violation.

The executable table of passing and failing phrases is in `test/quantities.test.ts`. Extend it whenever a real report trips the validator.

**Value matching (V2):** a claimed value matches the evidence value if it equals it, or equals it **rounded to 1–6 significant figures**. So 0.4684 → 0.47 or 0.5 is OK, 0.48 is not, and 31 → 30 is OK. Values must be in the evidence's unit: ratio, not percent (5.2 vs 0.052 fails).

## 4. Validator rules (deterministic)
| # | Rule | Violation when |
|---|---|---|
| V0 | Structure | `Report` (checked schema) fails |
| V1 | Evidence exists | a cited evidence id is unknown, or its status ≠ `ok` |
| V2 | Values grounded | `resolveField(evidence, field)` is undefined, or `!valueMatches(value, resolved)` |
| V3 | Quantities bound | `findUnboundQuantities()` returns an `unbound_quantity` in an observation, hypothesis, summary or timeline event; or a `{key}` has no value; or a value key is unused. Hypothesis placeholders must belong to observations the hypothesis cites |
| V4 | Hypotheses supported | a cited observation id is unknown |
| V5 | High confidence needs two sources | a `high` hypothesis's supporting observations don't cite both a `prometheus` and a `loki` evidence row |
| V6 | Timeline grounded | `at` is outside every queried window, or the event cites no evidence |
| V7 | Status consistency | `probable_cause` with zero hypotheses; or `insufficient_evidence` with a `high` hypothesis |
| V8 | References closed | a recommendation's `hypothesis_id` is unknown |

**Warnings (never fail a report):** `time_literal` in prose; quantities in `recommendations` (proposals, not facts, e.g. "raise max to 20"); `gaps` empty while some evidence has status `error`.

**On violations:** one repair round with the violation list. Then persist as `validation: "failed"` with violations; the UI shows it as **unvalidated**. Our code never silently edits a report.

## 5. UI requirements
Rendered numbers and evidence chips open `rendered_query`, `window`, `status` and `result`. Hypotheses show supporting and contradicting observations. `gaps`, warnings and validation status are always visible.
