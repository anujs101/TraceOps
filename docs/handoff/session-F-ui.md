# Handoff: session/F-ui (full UI redesign of apps/web/)

## Done and verified
- Commits `4447f69`…`96bf614`, steps (a)–(f), plus `94c2756`: a pinned unvalidated strip, added after the real-app check.
- `/verify` 17:31: typecheck passes in all 4 workspaces; tests contracts 114/114, demo-service 16/16, app 483 + 79 skipped, web 43/43.
- Web tests: every number opens its evidence and shows the exact stored value; the unvalidated banner and its violations stay visible with every `<details>` closed; no `ev_N`/`obs_N`/`hyp_N` text in the page body; `formatValue` checked on real run values; the recorded S1 run renders (16 evidence rows, TTR 37.8 s).
- Vite proxy target from `VITE_API_TARGET` (default `http://localhost:4000`). Unit-tested, and seen working live: 5174 → 4100.
- `/contract-check`: CONTRACTS UNCHANGED. Outside `apps/web/` only the build log and one proposal changed.
- Screenshots, viewed: 4 before/after pairs plus light 1440 and dark 390, in `~/TraceOps-video/screens/`. Every capture had 0 px horizontal overflow.

- Real app on :4000, with Postgres holding S1 runs 1 and 2 and S2. I ran Vite with no `VITE_API_TARGET`, i.e. its default target, and made GET requests only. Screens are in `~/TraceOps-video/screens/real-*.png`. Seen:
  - S2 is Unvalidated with 13 violations, and its V3 placeholders are flagged;
  - the S2 baseline line is drawn (ev_2, avg 112 ms);
  - ratio, ms and s units render correctly.
- That check found that 13 violations made the sticky banner cover half the screen. Fixed in `94c2756`.

## Done, not verified
- Keyboard focus return after closing the drawer, and contrast ratios: implemented but not measured.

## Not done
- No S2 run directory exists in `docs/runs/`, so the dev API (4100) has no S2. S2 was seen only through the real app.

## Deviations and proposals
- [validator-timeline-placeholders.md](../proposals/validator-timeline-placeholders.md): V3 doesn't check `{key}` in timeline events. The recorded S1 run passed with `{pool_used_early}` and `{pool_used_mid}` unbound. The UI marks them unbound.
- Report sections share one file, `report/Sections.tsx`; the theme follows the system by default.
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
