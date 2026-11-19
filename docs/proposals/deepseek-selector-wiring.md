# Proposal: wire the DeepSeek adapter into the provider selector

**From:** session E (`session/E-deepseek`) · **Status:** APPLIED by the main session at merge (selector + test). `sk-` redaction already in shared `redactSecrets` (b014d84); the env §6 amendment needs a `contracts/*` change (not done).

## Problem
`apps/traceops/src/llm/index.ts` `case 'deepseek'` still throws "not implemented yet". E owns only `src/llm/deepseek/`, so it can't edit the selector.

## Evidence
- The adapter is done: `src/llm/deepseek/` exports `createDeepSeekProvider(recorder, env)`, which returns a `RecordingProvider` wrapping `DeepSeekProvider`. 55 unit tests cover it in `test/llm/deepseek/adapter.test.ts`.
- One live smoke run on 2026-11-19 (`npm run smoke:deepseek -w @traceops/app`): strict mode accepted all 4 tool schemas and ReportApi, and the API reported the model as `deepseek-flash`.

## Proposed change (main session)
```diff
--- a/apps/traceops/src/llm/index.ts
+++ b/apps/traceops/src/llm/index.ts
@@
 import { createGroqClient, GroqProvider } from './groq/adapter.ts';
 import { loadGroqConfig } from './groq/config.ts';
+import { createDeepSeekProvider } from './deepseek/index.ts';
@@
     case 'deepseek':
-      // Contracts v1.2 names the provider; the adapter (src/llm/deepseek/) lands with session E.
-      throw new Error('LLM_PROVIDER "deepseek" is not implemented yet (session E adapter pending)');
+      return createDeepSeekProvider(recorder, env);
```
Also update `apps/traceops/test/llm/contracts-v1.1.test.ts:27`, which currently expects `/not implemented yet/` and should become `/DEEPSEEK_API_KEY is not set/`. Expected new behaviour: `createLlmProvider(rec, { LLM_PROVIDER: 'deepseek' })` throws `DEEPSEEK_API_KEY is not set` when there's no key, and returns a provider named `deepseek` when there is one.

## Also for main
- **`environment.md` §6 "DeepSeek specifics":** the open points can now be closed. Structured output uses a forced strict tool call (`submit_report`), not `response_format`. The error mapping is listed in `docs/handoff/session-E-deepseek.md`. The model id `deepseek-flash` is confirmed live.
- **`redactSecrets()` in `src/llm/errors.ts`** doesn't know DeepSeek's `sk-…` key shape. The adapter redacts it locally (`redactDeepSeek`). Main may want to move that into the shared function.
