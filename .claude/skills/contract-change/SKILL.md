---
name: contract-change
description: The procedure for changing a frozen TraceOps contract, seam or fixture (packages/contracts, docs/contracts, apps/traceops/src/seams.ts). Use when a proposal in docs/proposals/ is accepted, or when the user asks to change a contract.
---
# Changing a frozen contract

Contracts change only when implementation reveals a concrete problem, never for convenience (docs/contracts/README.md, "Change rule").

1. **Proposal first.** `docs/proposals/<topic>.md` must exist with: the problem, the evidence (observed output, failing test), the proposed change, and which sessions are affected. If it doesn't exist, write it and stop for the user's decision.
2. **Branch.** Work on `contracts/<topic>` (the path guard allows frozen paths only there), branched from `main`.
3. **One commit with everything:** markdown in `docs/contracts/`, the package in `packages/contracts/src/`, its tests, and recaptured fixtures if telemetry changed. Bump the version line in `docs/contracts/README.md` (v1.2, …) and add an amendments entry with the reason.
4. **Markdown and package must agree.** Disagreement is a bug; fix both in the same commit.
5. **Verify:** `/verify` passes for every workspace, not just contracts.
6. **Tell the sessions.** List the affected session branches; each rebases on the new `main` before continuing. Mark the proposal `APPLIED` with the commit hash.

Never weaken server-side validation to make a provider or a test pass.
