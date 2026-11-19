# Proposal: DeepSeek as a second LLM provider (Contracts v1.2)

**From:** main session (Wave 2 integration) · **Status:** ACCEPTED by the user 2026-11-19 · APPLIED in e64c8db (merged to main in e89ae2c)

## Problem
Wave 2 adds a DeepSeek adapter (session E) and runs the S1 end-to-end evaluation with `LLM_PROVIDER=deepseek`. The contracts don't allow it yet:
- `packages/contracts/src/llm.ts`: `LLM_PROVIDERS = ['groq']`. `selectedProvider()` (`apps/traceops/src/llm/index.ts`) rejects `deepseek` at startup, and `LlmCall.provider` rejects `deepseek` rows.
- `environment.md` §6: "Adding a provider (for example DeepSeek) means adding an adapter directory, a value in `LLM_PROVIDERS`, and its env vars here."
- `createLlmProvider`'s switch is typed on `LlmProviderName`, so an adapter can't be wired in without the contract value.
- Root `CLAUDE.md` rule 6 lists DeepSeek as Tier 2, "not built now".

## Evidence
- `apps/traceops/test/llm/contracts-v1.1.test.ts`: "rejects providers without an adapter (e.g. deepseek, until implemented)".
- DeepSeek's API docs (api-docs.deepseek.com, read 2026-11-19): an OpenAI-compatible base URL `https://api.deepseek.com`, bearer auth, and models `deepseek-flash` (DeepSeek-V4.1-Flash) and `deepseek-v4-pro`. Both models support JSON output and tool calls. The pages I read don't document a strict JSON-schema mode or the error-code mapping.

## Change (v1.2)
- `LLM_PROVIDERS = ['groq', 'deepseek']`. `LLM_DEFAULTS.provider` **stays `groq`**; DeepSeek is chosen with `LLM_PROVIDER=deepseek`.
- `LLM_DEFAULTS.deepseek = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', timeoutMs: 30000 }`. The model id is **to be confirmed by E's live smoke test**; if it is wrong, it is amended in a follow-up contract commit.
- `environment.md` §4: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL`, `DEEPSEEK_TIMEOUT_MS`. §6: DeepSeek specifics, with the structured-output mode and error mapping left open until E verifies them.
- `CLAUDE.md` rule 6: DeepSeek leaves Tier 2 (adapter only). Rule 4 also covers `DEEPSEEK_API_KEY`.
- App: `createLlmProvider` gains a `deepseek` case that throws "not implemented yet" until E's adapter is merged.

Server-side validation (`Report`, V0–V8) is unchanged and is never weakened for a provider.

## Affected sessions
- **E (new):** branches from the v1.2 commit.
- **D:** not affected (it uses only `createLlmProvider` / `LlmProvider`). Rebase on `main` before review.
- **A, B, C:** merged; no change.
