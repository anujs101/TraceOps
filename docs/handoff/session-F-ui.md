# Handoff: session/F-ui (UI redesign of apps/web/, v1 then v2)

## Done and verified
- v1: commits `4447f69`…`e371029` (readable formatting, drawer, tests). v2: `6d6dccd`, `8c4d7ce`, a laptop-first SaaS + observability redesign: sidebar shell, sticky right rail, Signals chart panels with axes.
- Build order (v1 a–f, v2 1–5) complete and committed. Final `/verify`: VERIFIED. All 4 workspaces typecheck; tests contracts 114/114, demo-service 16/16, app 483 (+79 skipped), web 45/45.
- Web tests cover:
  - every number opens its evidence and shows the exact stored value;
  - the unvalidated banner and strip are always visible;
  - no inline ids;
  - Signals panels open their evidence, and the axes are formatted from the stored series;
  - the sidebar's recent incidents and API status;
  - the recorded S1 run (`docs/runs/`).
- Final screenshots `~/TraceOps-video/screens/f01…f10`, all from the dev API on 4100 only, each 0 px horizontal overflow, key ones viewed: list, investigation, drawer, unvalidated (run 1 + fixture), light, 390, 1280×800, incident page, running.
- Earlier set `v2-01…12` is kept (incl. 1512); `v2-10…12` came from the real app on :4000 earlier (S2 Unvalidated, 13 violations, baseline drawn).
- `/contract-check`: CONTRACTS UNCHANGED. Outside `apps/web/` only build-log, handoff and one proposal changed.

## Done, not verified
- Keyboard focus return after closing the drawer, and contrast ratios: implemented but not measured.

## Not done
- No S2 folder in `docs/runs/`, so the dev API (4100) has no S2. S2 was seen only through the real app.

## Deviations and proposals
- [validator-timeline-placeholders.md](../proposals/validator-timeline-placeholders.md): V3 doesn't check timeline `{key}`s (S1 run 2 and S2 both show unbound ones). The UI marks them.
- The incident list reads N+1 (investigations + latest report per incident); the sidebar shares the same load. A summary endpoint would remove this (not proposed yet). List KPIs are display-only counts over loaded rows.
- Fixed in v2: an `sr-only` label inside `.table-wrap` escaped the scroll box and widened phones by 225 px. That was also the cause of the v1 "squeezed" 390 capture, which I wrongly called an artefact.

## How to run it
```bash
npm run dev:api:run -w @traceops/web                                   # dev API on 4100: S1 fixtures + docs/runs/*
VITE_API_TARGET=http://localhost:4100 npm run dev -w @traceops/web     # UI on 5173
npm run dev -w @traceops/web                                           # UI against the real app on 4000
npm test -w @traceops/web
```

## For the integrator
- The real app needs `.env`, which this worktree doesn't have: start it from the main checkout (`npm run start:env -w @traceops/app`).
- No new dependencies. Fonts: Geist / Geist Mono from Google Fonts, with system fallbacks.
- `dev-api-run.ts` refuses port 4000. `tsconfig.json` includes `scripts/`.
