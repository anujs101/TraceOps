# TraceOps MVP contracts — v1.3 (2026-11-19; v1.2 2026-11-19; v1.1 2026-11-18; v1 frozen 2026-11-17)

These are the boundaries that let the demo-service and TraceOps be built **in parallel**. A build session may depend only on these files and on `@traceops/contracts`, never on another session's implementation.

**Executable contracts:** `packages/contracts` (zod schemas, templates, grading and numeric-grounding rules, real fixtures). Its test suite must pass. Where this markdown and the package disagree, that's a bug: fix both in one commit.

| File | Defines | Produced by → consumed by |
|---|---|---|
| [environment.md](environment.md) | ports, containers, ownership, runtime conventions, env vars, fixture rules | everyone |
| [telemetry.md](telemetry.md) | resource attributes, metric names and sources, log fields, required logging behaviour | demo-service → detector, tools |
| [scenario-db-pool.md](scenario-db-pool.md) | S1 (leak) and S2 (CPU cause-vs-effect), validity gate, grading | demo-service + eval → everyone |
| [detection.md](detection.md) | symptom rules, rule state machine, incident record, windows | detector → worker |
| [tools.md](tools.md) | tool schemas (API layer + checked layer), templates, log allowlist, stats keys | tool layer → investigator |
| [evidence-and-report.md](evidence-and-report.md) | evidence, report, numeric grounding, validator V0–V8 | investigator → validator, UI |
| [persistence.md](persistence.md) | tables, job queue, state machines | TraceOps internals |

## v1.1 amendments (2026-11-18): provider-neutral LLM layer
Only these changed relative to frozen v1 (`05cad4a`). Everything else is identical.
- `persistence.md` §1a: `llm_calls` gains `attempt, provider, stage, kind, status, request_id, tool_call_count, error_kind, error_status, error_message, retry_after_ms, provider_timings`. Token columns become nullable. No v1 column is removed.
- `environment.md` §4 and new §6: `LLM_PROVIDER`, `GROQ_*` variables, the provider interface, adapter requirements and error handling. `ANTHROPIC_API_KEY` is removed.
- `tools.md` §1 and `evidence-and-report.md` §2: provider-neutral wording (Groq replaces the Claude `output_config` references).
- `packages/contracts/src/llm.ts`: `LlmCall`, `LLM_ERROR_KINDS`, `LLM_DEFAULTS` (+ tests).

## v1.3 amendments (2026-11-19): `error_ratio_5xx` is 0, not empty, without 5xx
**Reason:** with no 5xx series the old numerator was empty, so the whole ratio was empty, which counts as missing data. detection.md §3 says missing data never resolves an incident, and §4 resolves only when every rule is `ok`. So an `http-slo` incident could never resolve on a healthy service. This was seen in both live S1 runs: the error-ratio rule reported `empty` through the healthy baseline, and each run's incident stayed `open` until the database was edited (`docs/proposals/detection-error-ratio-empty.md`). Only these changed relative to v1.2:
- `packages/contracts/src/telemetry.ts` `METRIC_TEMPLATES.error_ratio_5xx`: the numerator becomes `(sum(rate(…5..…[1m])) or vector(0))`, and the denominator is unchanged. With traffic and no 5xx the result is `0`; with no traffic the denominator is empty, so the result is still empty and counts as missing data. Tests added.
- `tools.md` §3 and `detection.md` §3: one sentence each on the new behaviour.
- **Fixtures (unchanged):** `S1/` and `S2/prom-error_ratio_5xx.json` are raw responses to the *old* query, captured 2026-11-16 in the lab stack. They stay valid backend responses (schema tests pass), and no test depends on the points the new query would add. But they are **not** what the new query returns for those windows: it would add `0`-valued points at times with traffic and no 5xx. They are not recaptured, because the lab data is gone; a later recapture will replace them.

## v1.2 amendments (2026-11-19): DeepSeek provider
**Reason:** Wave 2 adds a DeepSeek adapter (session E). `environment.md` §6 requires a new provider to be a value in `LLM_PROVIDERS` with its env vars in the contract, and the app's provider switch is typed on `LlmProviderName`, so the adapter cannot be built without this change (`docs/proposals/llm-provider-deepseek.md`). Only these changed relative to v1.1. Everything else is identical.
- `packages/contracts/src/llm.ts`: `LLM_PROVIDERS = ['groq', 'deepseek']`; `LLM_DEFAULTS.deepseek = { model, baseUrl, timeoutMs }`. `LLM_DEFAULTS.provider` stays `groq`; DeepSeek is selected with `LLM_PROVIDER=deepseek`. `LlmCall.provider` accepts `deepseek` (+ tests).
- `environment.md` §4: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_TIMEOUT_MS`. §6: DeepSeek specifics.
- The model id `deepseek-flash` comes from DeepSeek's docs and is **not yet live-verified** (VERIFY item 5).

## Change rule
v1 is frozen. A change is its own commit (markdown + package + tests, + recaptured fixtures if telemetry changed) with the reason, and only when implementation reveals a concrete problem. A build session that finds a contract wrong **stops and reports**; it never diverges silently.

## What is verified — by experiment, on this laptop
Evidence: `docs/research/spike-observability.md`, `docs/research/pool-lab.md`.
- Metric/label/log names and shapes as stored by `grafana/otel-lgtm:0.40.0`.
- `instrumentation-pg` pool gauges go stale under a leak → replaced by export-time gauges (S1 rerun: pending up to 62).
- Gauge staleness after restart → `last_over_time(...[15s])` required.
- S1 and S2 signal profiles and the discriminators between them.
- Report and tool schemas pass an **offline** check against the documented structured-output limits.

## ⚠ NOT verified — open VERIFY items (do not treat as verified)
1. ~~Live structured-output call.~~ **Resolved in v1.1:** `ReportApi` (strict) and all four tool schemas were accepted live by Groq `openai/gpt-oss-20b` (2026-11-17). Not verified for any other provider.
2. **S2 stability on the recording day.** S2 runs at CPU saturation; screen recording or other load will shift it. `CPU_ITER` may need retuning; rely on the validity gate.
3. **Detector behaviour in S2.** Only the latency rule is expected to fire (5xx ≈ 0). Not yet exercised by a detector implementation.
4. **Redaction patterns** (tokens, emails, connection strings) are specified but have no test corpus; the demo app emits none, so the fixtures cannot exercise them.

5. **DeepSeek (v1.2).** Default model id `deepseek-flash`, the strictest structured-output mode, error-code mapping, and whether `ReportApi` and the four tool schemas are accepted live. All to be verified by session E's live smoke test.

## ⚠ Untested assumptions
- **S2 fixture baseline is contaminated.** `fixtures/S2/` was captured 27 s after the S1 run ended on the same `service_name`. Its window `start..deploy_at` (18:31:06–18:32:37Z) carries S1 values through `rate(...[1m])` and the 5-min gauge lookback. **Use S2 signals only from `deploy_at + 60 s`.** Documented in `fixtures/S2/manifest.json` (`notes`). A clean S2 recapture (after a ≥ 5 min cool-down) would replace it.
- The model will write quantities as `{key}` placeholders and the one-round repair loop will converge — untested until real reports exist.
- Backend ingestion lag at the end of the incident window (a few seconds) — not measured.
- All lab numbers come from runs without screen recording.
- The pool lab (`spike/pool-lab/`) is throwaway verification code, not the demo-service implementation.
