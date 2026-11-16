# Contract: deterministic detection and incidents

**Status:** frozen v1 (2026-11-17) · **Executable source:** `packages/contracts/src/incident.ts` · **No LLM in this path.**

## 1. Principle
Rules fire on **symptoms** (latency, errors), never on suspected causes. The incident stores symptom values only.

## 2. Rule config (`config/rules.yaml`, validated by `RuleConfig`)
```yaml
rules:
  - id: http-latency-p95
    service: demo-service
    group: http-slo          # rules in one group share one incident
    query: latency_p95       # only symptom templates allowed: latency_p95 | error_ratio_5xx
    op: ">"
    threshold: 1.0
  - id: http-error-ratio
    service: demo-service
    group: http-slo
    query: error_ratio_5xx
    op: ">"
    threshold: 0.05
evaluation:
  interval_s: 15
  fire_after: 2
  resolve_after: 4
  query_timeout_s: 5
  reopen_window_s: 300
```

## 3. Rule state machine (per rule; in memory; rebuilt by re-evaluating on restart)
`ok → pending(n) → firing → recovering(n) → ok`. A breach while recovering → `firing`; OK while pending → `ok`.
**Missing data** (empty result, NaN, query error): no transition, logged and counted. It never resolves an incident.
The detector uses `/api/v1/query` (instant) with the same template strings as the tools.

## 4. Incident lifecycle
- **Fingerprint** = `sha256(service + ":" + group)` (hex, 64 chars).
- **Open** when the first rule in the group reaches `firing`. The partial unique index on open fingerprints makes a duplicate impossible. If one is already open, update `trigger` and `severity`.
- **Resolve** when every rule in the group is `ok`. **Reopen** if it fires again within `reopen_window_s` (`reopen_count++`).
- **Open + enqueue** happen in one transaction (job key `incident:<id>:auto`).

## 5. Incident record
```ts
type Incident = {
  id: uuid; fingerprint: string; service: string; group: string;
  status: "open" | "resolved"; severity: "critical" | "warning";   // critical if every rule in the group fired
  started_at: IsoUtcMs;   // first breaching evaluation
  detected_at: IsoUtcMs;  // fire_after reached
  resolved_at: IsoUtcMs | null; reopen_count: number;
  trigger: { rule_id; query; threshold; observed; at: IsoUtcMs }[];   // ≥ 1
};
```

## 6. Investigation windows (`deriveWindows`, tested)
- `incident` = [`started_at − 2 min`, investigation start]
- `baseline` = the same length (capped at 15 min), ending where `incident` starts
- `allowed` = [`started_at − 60 min`, investigation start]: every tool window must lie inside

**Known effect:** both backends ingest with a lag of a few seconds, so the last ~10 s of `incident` may be incomplete when the investigation starts. The investigator's system prompt states this; it is not compensated.
