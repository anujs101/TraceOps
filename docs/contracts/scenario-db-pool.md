# Contract: evaluation scenarios

**Status:** frozen v1 (2026-11-17) · **Executable source:** `packages/contracts/src/grading.ts` · Evidence: `docs/research/pool-lab.md`
Both scenarios trigger **the same symptom alert**, so the incident never reveals the cause.

## Change from rc1: S2 is now a cause-vs-effect test
rc1 predicted that a CPU-bound fault would leave the pool healthy (`used` < `max`, no timeouts). **Measured, that's false.** At 30 rps, every CPU fault strong enough to push p95 above the 1 s alert threshold saturated the event loop (utilisation = 1). Query callbacks then ran late, connections were held longer, and the pool reached `max` with real acquire timeouts:
- continuous burn: 0–343 timeouts
- intermittent long blocks: 131–419 timeouts

In Node, **pool exhaustion is a side effect of CPU starvation.** So S2 tests whether the investigator separates **cause from effect**. It no longer tests "pool metrics stayed quiet".

## S1: connection leak (`FAULT=pool_leak`, `SERVICE_VERSION=1.0.1`)
| | |
|---|---|
| Ground truth | `POST /orders` returns 409 on insufficient stock **without `client.release()`** |
| Injection | Restart (simulated deploy) with the flag on. Load: 30 rps, 20% orders, 2% of orders for zero-stock products |
| Signals measured (pool lab rerun, export-time gauges) | `used` 1 → 10 and **stays 10 after load drops to 20%** · `idle` → 0 · **pending up to 62** · acquire wait p95 2.47 s · timeouts 10–29/s · 5xx 35–100% · p95 2.42 s · **event-loop utilisation ≤ 0.21 · query p95 ≤ 5 ms** after deploy (DB itself healthy) |
| Discriminators vs S2 | no recovery after load drop; event loop not busy; queries fast |
| Ground-truth category | `db_pool_exhaustion` |

## S2: CPU starvation with secondary pool saturation (`FAULT=cpu_burn`, `CPU_ITER=300000`, `SERVICE_VERSION=1.0.1`)
| | |
|---|---|
| Ground truth | `GET /products` runs `crypto.pbkdf2Sync` (~33 ms per call on the M2), saturating the event loop |
| Signals measured (pool lab, CPU_ITER=300000, two runs) | event-loop utilisation **1.0**, delay p99 0.4–0.9 s · p95 latency 2.35–2.43 s · **`used` = 10, `idle` = 0, pending 17–21** (looks like S1) · acquire wait p95 1.0–1.4 s · **query p95 0.5–0.7 s** (callbacks delayed) · acquire timeouts 0 (run 2) to 5 (run 1) · 5xx ≈ 0–0.7% → **only the latency rule fires** |
| Discriminators vs S1 | event loop saturated (1.0 vs ≤ 0.35); query duration inflated (0.5–0.7 s vs ≤ 0.05 s); acquire wait below the 2 s timeout; few or no timeouts; **the pool recovers** when load drops (`used` 0–3, measured) |
| Ground-truth category | `cpu_saturation` (a secondary `db_pool_exhaustion` hypothesis is *correct as an effect* and allowed below it) |

## Load profile
Load generator: open loop, 30 rps, 80% `GET /products` / 20% `POST /orders`, `LOW_STOCK_SHARE=0.02`.
**Timeline:**
1. Baseline on `FAULT=none, 1.0.0` (≥ 90 s).
2. Restart with the fault.
3. Keep the load running until the incident is detected, plus 3 min.
4. Drop to 6 rps for ≥ 60 s.

**Cool-down: ≥ 5 min between scenario runs** that reuse `service_name`. Measured: an S2 run started 27 s after S1 had a "baseline" with p95 2.4 s and 5xx 100%, carried over through `rate(...[1m])` windows and the 5-min gauge lookback.

## Scenario validity gate (`scenarioValid`): checked from telemetry before grading
A run counts only if the fault manifested as specified. Invalid runs are reported, not graded.
- **Both:** baseline clean (p95 < 0.5 s, no 5xx).
- **S1:** latency alert fired · `used` = `max` for ≥ 60 s · timeouts > 0 · event-loop utilisation < 0.5 · `used` still = `max` after the load drop.
- **S2:** latency alert fired · event-loop utilisation ≥ 0.9.

## Grading (`gradeRun`): deterministic, no LLM judge
| Outcome | Definition |
|---|---|
| `correct` | top hypothesis category = ground truth (S1 also needs the top hypothesis's supporting observations to cite **both** a Prometheus and a Loki evidence row) |
| `safe` | no wrong root cause asserted: `insufficient_evidence`, **an empty hypothesis list**, or a top category that's neither the truth nor the decoy |
| `misattributed` | top category = the decoy (S1 decoy `cpu_saturation`; S2 decoy `db_pool_exhaustion`) |
| `invalid` | report failed validation |

**Pass:** S1 = `correct` only. S2 = `correct` **or** `safe` (it's a negative control for misattribution; an empty hypothesis list passes). S2's `correct` rate is reported separately as the stronger result.

## Protocol
N = 5 graded runs per scenario: re-investigations of the same incident (model variance) plus ≥ 2 fresh scenario runs (environment variance). Each run records: validity, outcome, latency, tool calls, tokens, cost. Report the raw table. **No unmeasured numbers.**

**Known sensitivity:** S2 sits close to CPU saturation, so CPU taken by screen recording or other apps on the same laptop shifts it. The validity gate catches runs that didn't saturate; `CPU_ITER` may need retuning on the recording day.
