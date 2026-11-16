# Proposal: Contracts v1.1 — provider-neutral LLM persistence and configuration

**Status:** PROPOSED, not applied. Contracts v1 (`05cad4a`) stays unchanged until this is approved.
**Trigger:** Groq chosen as the initial LLM provider (Groq spike, `apps/traceops/src/llm/`). v1 assumes Anthropic in three places.
**Scope:** minimal. Three amendments, no new tables, no new documents.

## A1. `persistence.md` — `llm_calls` becomes provider-neutral
v1 columns: `id, investigation_id, turn, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, stop_reason, created_at`.

| Change | Why (evidence) |
|---|---|
| **add** `provider text not null` | model ids aren't unique across providers |
| **add** `stage text not null` (`investigate` / `report`) and `kind text not null` (`chat` / `structured`) | the two stages are separate requests (Groq can't combine tools + structured output) |
| **add** `status text not null` (`ok` / `error`) | 8 of 21 live calls were errors; v1 has no place for them |
| **add** `error_kind text null` — one of `auth, rate_limit, capacity, server, timeout, connection, bad_request, invalid_generation, malformed_response, truncated, schema_violation, aborted, unknown` | observed live: `rate_limit` ×5, `invalid_generation` ×1, `auth` ×1, plus 1 `bad_request` from the run before the fix |
| **add** `error_status int null`, `retry_after_ms int null` | live 429s asked for 1–34 s |
| **add** `request_id text null` | Groq `x_groq.id`, for support/debugging |
| **add** `tool_call_count int null` | per chat turn |
| **add** `provider_timings jsonb null` | Groq reports queue/prompt/completion ms (queue observed 46–591 ms) |
| **make nullable** `input_tokens, output_tokens` | errors have no usage |
| **make nullable** `cache_read_tokens` | Anthropic-specific; Groq doesn't report it |
| **one row per provider attempt** (retries included) | each live retry was a separate billable/limited request |

Never stored: prompts, model outputs (those live in `evidence` / `reports`), API keys, headers.
The implementation already produces exactly these fields (`LlmCallRecord` in `apps/traceops/src/llm/recorder.ts`).

## A2. `environment.md` §4 — LLM configuration
Replace the `ANTHROPIC_API_KEY` row with:

| Var | Used by | Default / example |
|---|---|---|
| `LLM_PROVIDER` | TraceOps | `groq` (only implemented value) |
| `GROQ_API_KEY` | TraceOps | required; read only by the Groq adapter; never logged, never in fixtures/records |
| `GROQ_MODEL` | TraceOps | `openai/gpt-oss-20b` |
| `GROQ_TIMEOUT_MS` | TraceOps | `30000` |
| `GROQ_REASONING_EFFORT` | TraceOps | unset (`low`/`medium`/`high` allowed) |

And add one rule: *investigator code depends only on the provider-neutral interface (`apps/traceops/src/llm/types.ts`); provider SDKs are imported only inside their adapter directory.*

## A3. Provider-neutral wording in `tools.md` §1 and `evidence-and-report.md` §2
- "sent as `output_config.format`" → "sent as the provider's strict structured-output schema (Groq: `response_format.json_schema` with `strict: true`)".
- "constructs the structured-output API supports" → "constructs supported by every enabled provider's strict mode". The API-layer schemas must pass both `structuredOutputProblems()` (contracts) and the provider's own check (`groqStrictProblems()`), which they already do; the live Groq strict request with `ReportApi` was accepted.
- Add: *structured output and tool use are separate requests.*

## Not proposed (implementation notes, not contract changes)
- Groq can reject the model's own output with HTTP 400 (`tool_use_failed`, and `json_validate_failed` even in strict mode). The adapter treats these as a retryable `invalid_generation`.
- The default retry cap (20 s) is below observed `retry-after` values (34 s). That's an implementation/config decision for the job layer.
- `apps/traceops` links contracts via `file:` instead of the npm workspaces in environment.md §3, to avoid touching the frozen contracts lockfile. Moving to workspaces can come later as its own change.
