---
description: Run scenario S1 live end to end and report validity and the investigation result
---
Run S1 (connection leak) on the live stack using the `scenario-runner` skill, then report:

1. Stack status (containers up, demo-service healthy).
2. The scenario's `SignalSummary` and `scenarioValid('S1', …)` result. An invalid run is reported, not graded.
3. If TraceOps is running: the incident (id, `started_at`, `detected_at`), the investigation status, the report's `status`, top hypothesis category, `validation`, violations if any, and `llm_calls` totals (attempts, tokens, latency, errors).
4. Time from `detected_at` to the report row.

Run long steps in the background. Never print `.env` or the API key.
