# Ownership: which branch may edit which paths

Enforced by `.claude/hooks/guard-paths.sh` on every Edit/Write. The hook parses the **Owned paths** table below, so keep its format: one row per branch, paths in backticks, a trailing `/` means "this directory and everything under it".

## Always blocked
- `.env` (every branch)
- Frozen: `packages/contracts/`, `docs/contracts/`, `apps/traceops/src/seams.ts`. Editable only on a `contracts/*` branch, following the `contract-change` skill.

## Owned paths
| Branch | Session | May edit |
|---|---|---|
| `session/A-demo` | A: demo-service + infra | `infra/` `apps/demo-service/` |
| `session/B-tools` | B: tool adapters | `apps/traceops/src/tools/` `apps/traceops/test/tools/` `apps/traceops/package.json` |
| `session/C-detector` | C: detector, queue, database | `apps/traceops/src/detector/` `apps/traceops/src/queue/` `apps/traceops/src/db/` `apps/traceops/config/` `apps/traceops/test/detector/` `apps/traceops/test/queue/` `apps/traceops/test/db/` `apps/traceops/package.json` |
| `session/D-investigator` | D: investigator, API, UI | `apps/traceops/src/investigator/` `apps/traceops/src/api/` `apps/traceops/test/investigator/` `apps/traceops/test/api/` `apps/web/` `apps/traceops/package.json` |
| `session/E-deepseek` | E: DeepSeek adapter | `apps/traceops/src/llm/deepseek/` `apps/traceops/test/llm/deepseek/` `apps/traceops/package.json` |

**Every session branch** may also write `docs/proposals/`, `docs/build-log/` and `docs/handoff/`.

**Any other branch** (`main`, `integration/*`): the main session, which may edit everything except the always-blocked paths.

## Shared files
- `apps/traceops/package.json`: B, C, D and E may **add** dependencies only. Expect a trivial merge; the root `package-lock.json` is regenerated with `npm install` at merge time, never hand-merged.
- Root `package.json`, `CLAUDE.md`, `.claude/`, `docs/specs/`, `docs/OWNERSHIP.md`: main session only.

## Merge order (Wave 2)
C → B → A → E → D. Run `contract-guardian` and `/code-review` on each branch before merging it.
