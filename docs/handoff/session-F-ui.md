# Handoff: session/F-ui (full UI redesign of apps/web/)

## Done and verified
- Commits `4447f69`…`96bf614`, steps (a)–(f): tokens and format, investigation page with verdict and drawer, incident list, incident page, states, light polish.
- `/verify` 17:12: typecheck passes in all 4 workspaces; tests contracts 114/114, demo-service 16/16, app 483 + 79 skipped, web 43/43.
- Web tests:
  - every number is clickable (each `num-*` opens the drawer, the claim matches, the exact stored value is shown);
  - the unvalidated banner and its violations stay visible with every `<details>` closed;
  - no `ev_N`/`obs_N`/`hyp_N` text in the page body;
  - `formatValue` table on real run values;
  - the recorded S1 run (`docs/runs/s1-20261119T104115Z`) renders: 16 evidence rows, 4 budget_exhausted, TTR 37.8 s, key numbers.
- Vite proxy target from `VITE_API_TARGET` (default `http://localhost:4000`). Unit-tested, and seen working live: 5174 → 4100.
- `/contract-check`: CONTRACTS UNCHANGED. Outside `apps/web/` only the build log and one proposal changed.
- Screenshots, viewed: 4 before/after pairs plus light 1440 and dark 390, in `~/TraceOps-video/screens/`. Every capture had 0 px horizontal overflow.

## Done, not verified
- Against the real app on :4000 with S1 + S2 in Postgres: not run. Nothing was listening on 4000, and starting `src/app/main.ts` also starts the detector and worker and needs `.env`.
- Keyboard focus return after closing the drawer, and contrast ratios: implemented but not measured.

## Not done
- No S2 run directory exists in `docs/runs/`, so the dev API (4100) serves the S1 runs plus the fixtures only.

## Deviations and proposals
- [validator-timeline-placeholders.md](../proposals/validator-timeline-placeholders.md): V3 doesn't check `{key}` in timeline events. The recorded S1 run passed with `{pool_used_early}` and `{pool_used_mid}` unbound. The UI marks them unbound.
- Report sections are grouped into `report/Sections.tsx` rather than one file per section.
- A theme toggle follows the system theme by default.
- Prose like "{el_max} s" absorbs the unit and shows "19.4 ms". Only when the following unit exactly equals the evidence unit (s, req/s, timeouts/s).
- The list makes N+1 reads (investigations + latest report per incident). A summary endpoint would remove this (not proposed yet).

## How to run it
```bash
npm run dev:api:run -w @traceops/web                                   # dev API on 4100: S1 fixtures + docs/runs/*
VITE_API_TARGET=http://localhost:4100 npm run dev -w @traceops/web     # UI on 5173
npm run dev -w @traceops/web                                           # UI against the real app on 4000
npm test -w @traceops/web
```

## For the integrator
- `dev-api-run.ts` refuses port 4000. `scripts/load-run.ts` reads `docs/runs/<run>/{summary,evidence,report,llm_calls}.json`.
- `tsconfig.json` now includes `scripts/`. No new dependencies.
- Fonts come from Google Fonts (Atkinson Hyperlegible Next/Mono), with system fallbacks, so offline is fine.
