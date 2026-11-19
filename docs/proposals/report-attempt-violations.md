# Proposal: store each report attempt's validation result (first attempt + repair)

**From:** main session (Wave 2) · **Severity:** observability, not correctness · 2026-11-19 · **Status:** OPEN, needs a `contracts/*` change

## Problem
In live S1 run 2 the repair round ran and the stored report passed validation, but nobody can say what the repair fixed. `persistence.md` §1 has one `reports` row per investigation (`investigation_id PK`, `violations jsonb`, `warnings jsonb`, `repair_attempted`), and `generateValidatedReport` saves only the final attempt. The first attempt's violations exist in memory (`ReportOutcome.attempts`, `apps/traceops/src/report/generate.ts`) and are then dropped. Measuring how well the repair prompt works, and showing it in the UI, needs them stored.

## Evidence
- `docs/runs/s1-20261119T104115Z/summary.json`: `repair_attempted: true`, `validation: passed`, `violations: []`. The first attempt's violations are not recoverable.
- `persistence.md` §1 is frozen DDL (persistence.md §1a: "exactly as written"), so adding a column or table is a contract change.

## Proposed change (v1.3)
Add one column to `reports`, with no new table:
```sql
attempts jsonb NOT NULL DEFAULT '[]'
  -- [{ round: 0|1, validation: 'passed'|'failed', violations: [...], warnings: [...] }], in round order
```
- It stores **only the validator output per round**, never the model's earlier report text (persistence.md §1: model outputs live only in `evidence` and `reports`; the final report stays in `report`).
- The `violations`/`warnings` columns keep meaning "the final attempt", so existing readers (D's API, the UI, the validator tests) don't change.
- `ReportRow` gains `attempts`. `generateValidatedReport` fills it from `ReportOutcome.attempts`, and `PgInvestigationStore.reportSink.save` / `getReport` write and read it.
- Migration `002_report_attempts.sql`: `ALTER TABLE reports ADD COLUMN attempts jsonb NOT NULL DEFAULT '[]'`.

## Affected
- **Contracts:** `persistence.md` §1 (+ §1a DDL), and `evidence-and-report.md` §4 "On violations" gains one sentence: each round's validator result is stored.
- **C (db):** the migration and the store (main-owned now).
- **D (API/UI):** `GET /api/investigations/:id/report` returns `attempts`, and the UI can show "repair fixed: [V0] …".
- **Seam:** `InvestigationStore.getReport` returns `ReportRow`, which is defined in `report/generate.ts`, not in `seams.ts`. Check this when applying.
