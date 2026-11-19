/**
 * Runs scenario S1 (pool_leak) or S2 (cpu_burn) live and prints the SignalSummary + scenarioValid().
 * Usage: tsx scripts/run-scenario.ts S1|S2      (needs `npm run build` and `docker compose -f infra/compose.yml up -d`)
 *
 * Timeline (docs/contracts/scenario-db-pool.md "Load profile"):
 *   0. cool-down: wait until Prometheus holds no demo-service samples from the last 5 min
 *   1. baseline on FAULT=none, 1.0.0 at 30 rps for 7 min (contract: >= 90 s; see BASELINE_S)
 *   2. restart with the fault on 1.0.1 (simulated deploy), load continues
 *   3. keep load until the latency alert condition holds (detection.md: p95 > 1.0 s, fire_after 2 at 15 s), plus 3 min
 *   4. drop to 6 rps for >= 60 s
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPromql, scenarioValid, SERVICE, type MetricName, type Scenario, type SignalSummary } from '@traceops/contracts';
import { startLoad, type LoadHandle } from '../load/load';

// ---- numbers taken from the contracts (do not tune here) ----
// scenario-db-pool.md: baseline >= 90 s. 90 s is too short for the investigator's derived baseline window
// (detection.md §6): incident = [started_at - 2 min, investigation start] (~2 min 20 s), baseline = the same
// length just before it, so it starts ~4 min 20 s before started_at. started_at can come ~5-25 s after the
// deploy, and rate[1m] / the 15 s gauge lookback need ~75 s of healthy samples first: healthy 1.0.0 traffic
// must start >= ~5.75 min before the deploy. 7 min leaves ~70 s for a slow worker pickup.
// (Round-1 runs at 90 s: the S2 baseline window was entirely before demo-service started, S1's only partly covered.)
const BASELINE_S = 420;
const LOAD_RPS = 30;
const LOW_STOCK_SHARE = 0.02;
const DROP_RPS = 6;
const DROP_S = 60; // >= 60 s
const AFTER_ALERT_S = 180; // "until the incident is detected, plus 3 min"
const COOLDOWN_S = 300; // ">= 5 min between scenario runs that reuse service_name"
const ALERT = { threshold: 1.0, fireAfter: 2, intervalS: 15 }; // detection.md rules.yaml: http-latency-p95
const EXPORT_INTERVAL_S = 5; // telemetry.md §2; also the query step
// ---- script-only safety limit, NOT a load-profile number ----
const ALERT_WAIT_CAP_S = 600;

const PROM = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const APP = 'http://localhost:8080';
const HERE = path.dirname(fileURLToPath(import.meta.url ?? `file://${__filename}`));
const SVC_DIR = path.resolve(HERE, '..');
const RUNS = path.join(SVC_DIR, 'runs');

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

// ---- Prometheus ----
async function promInstant(query: string, at?: number): Promise<number | undefined> {
  const u = new URL('/api/v1/query', PROM);
  u.searchParams.set('query', query);
  if (at !== undefined) u.searchParams.set('time', String(at));
  const j = (await (await fetch(u)).json()) as { data: { result: { value: [number, string] }[] } };
  const v = Number(j.data.result[0]?.value[1]);
  return Number.isFinite(v) ? v : undefined;
}
async function promRange(query: string, start: number, end: number): Promise<number[]> {
  const u = new URL('/api/v1/query_range', PROM);
  u.searchParams.set('query', query);
  u.searchParams.set('start', String(start));
  u.searchParams.set('end', String(end));
  u.searchParams.set('step', String(EXPORT_INTERVAL_S));
  const j = (await (await fetch(u)).json()) as { data: { result: { values: [number, string][] }[] } };
  return (j.data.result[0]?.values ?? []).map(([, v]) => Number(v)).filter(Number.isFinite);
}
const tpl = (m: MetricName) => renderPromql(m, SERVICE);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

// ---- demo-service process ----
async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${APP}/healthz`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
function startApp(env: Record<string, string>, logFile: string): ChildProcess {
  const out = createWriteStream(logFile, { flags: 'a' });
  const p = spawn('node', ['--require', './dist/otel.js', './dist/main.js'], {
    cwd: SVC_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout?.pipe(out);
  p.stderr?.pipe(out);
  return p;
}
async function waitHealthy(timeoutS = 30) {
  for (let i = 0; i < timeoutS * 4; i++) {
    if (await healthy()) return;
    await sleep(0.25);
  }
  throw new Error('demo-service did not become healthy');
}
async function stopApp(p: ChildProcess) {
  if (p.exitCode !== null) return;
  const exited = new Promise<void>((r) => p.once('exit', () => r()));
  p.kill('SIGTERM');
  await exited;
}

async function main() {
  const scenario = process.argv[2] as Scenario;
  if (scenario !== 'S1' && scenario !== 'S2') throw new Error('usage: run-scenario.ts S1|S2');
  const fault = scenario === 'S1' ? 'pool_leak' : 'cpu_burn';
  mkdirSync(RUNS, { recursive: true });
  const appLog = path.join(RUNS, `${scenario}-app.log`);
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const now = () => Math.floor(Date.now() / 1000);

  if (await healthy()) throw new Error('something already listens on :8080; stop it first');
  if ((await fetch(`${PROM}/api/v1/status/buildinfo`).catch(() => undefined))?.ok !== true) throw new Error(`Prometheus not reachable at ${PROM}`);

  // 0. cool-down: any demo-service sample inside the last 5 min means a previous run is too recent
  const recent = `count(count_over_time(${'nodejs_eventloop_utilization_ratio'}{service_name="${SERVICE}"}[${COOLDOWN_S}s]))`;
  for (let waited = false; (await promInstant(recent)) !== undefined; waited = true) {
    if (!waited) log(`cool-down: demo-service samples younger than ${COOLDOWN_S}s exist; waiting for them to age out`);
    await sleep(ALERT.intervalS);
  }

  let app: ChildProcess | undefined;
  let load: LoadHandle | undefined;
  try {
    // 1. baseline
    log('baseline: FAULT=none SERVICE_VERSION=1.0.0');
    app = startApp({ FAULT: 'none', SERVICE_VERSION: '1.0.0' }, appLog);
    await waitHealthy();
    const tBaselineStart = now();
    load = startLoad({ base: APP, rps: LOAD_RPS, lowStockShare: LOW_STOCK_SHARE });
    await sleep(BASELINE_S);

    // 2. simulated deploy
    log(`deploy: FAULT=${fault} SERVICE_VERSION=1.0.1`);
    const tDeploy = now();
    await stopApp(app);
    app = startApp({ FAULT: fault, SERVICE_VERSION: '1.0.1' }, appLog);
    await waitHealthy();

    // 3. until the latency alert condition holds, plus 3 min
    let breaches = 0;
    let alertFired = false;
    for (let waited = 0; waited < ALERT_WAIT_CAP_S && !alertFired; waited += ALERT.intervalS) {
      await sleep(ALERT.intervalS);
      const v = await promInstant(tpl('latency_p95'));
      if (v === undefined) continue; // missing data: no transition (detection.md §3)
      breaches = v > ALERT.threshold ? breaches + 1 : 0;
      alertFired = breaches >= ALERT.fireAfter;
      log(`latency_p95=${v.toFixed(3)} breaches=${breaches}/${ALERT.fireAfter}`);
    }
    log(alertFired ? `latency alert condition holds; load continues ${AFTER_ALERT_S}s` : `alert did not fire within ${ALERT_WAIT_CAP_S}s (script safety cap)`);
    if (alertFired) await sleep(AFTER_ALERT_S);

    // 4. load drop
    load.stop();
    log(`${load && JSON.stringify(load.stats)}`);
    const tDrop = now();
    load = startLoad({ base: APP, rps: DROP_RPS, lowStockShare: LOW_STOCK_SHARE });
    await sleep(DROP_S);
    load.stop();
    const tEnd = now();
    await sleep(2 * EXPORT_INTERVAL_S); // let the last exports land before querying
    log('queries');

    // ---- SignalSummary from Prometheus (the same templates the tools use) ----
    const baseP95 = await promRange(tpl('latency_p95'), tBaselineStart, tDeploy);
    const base5xx = await promRange(tpl('error_ratio_5xx'), tBaselineStart, tDeploy);
    const used = await promRange(tpl('pool_used'), tDeploy, tDrop);
    const poolMaxSeries = await promRange(tpl('pool_max'), tDeploy, tEnd);
    const poolMax = max(poolMaxSeries);
    const timeouts = await promInstant(`sum(increase(db_client_connection_timeouts_total{service_name="${SERVICE}"}[${tEnd - tDeploy}s]))`, tEnd);
    const elu = await promRange(tpl('eventloop_utilization'), tDeploy, tDrop);
    const usedAfterDrop = await promInstant(tpl('pool_used'), tEnd);

    const summary: SignalSummary = {
      baseline_clean: baseP95.length > 0 && max(baseP95) < 0.5 && max(base5xx) === 0,
      latency_alert_fired: alertFired,
      pool_used_max: max(used),
      pool_max: poolMax,
      pool_used_at_max_seconds: poolMax > 0 ? used.filter((u) => u >= poolMax).length * EXPORT_INTERVAL_S : 0,
      pool_timeouts_increase: timeouts ?? 0,
      eventloop_utilization_max: max(elu),
      pool_used_after_load_drop: scenario === 'S1' ? (usedAfterDrop ?? null) : null,
    };
    const verdict = scenarioValid(scenario, summary);
    const times = { tBaselineStart: iso(tBaselineStart), tDeploy: iso(tDeploy), tDrop: iso(tDrop), tEnd: iso(tEnd) };
    writeFileSync(path.join(RUNS, `${scenario}-summary.json`), JSON.stringify({ scenario, times, summary, verdict }, null, 2));
    console.log(JSON.stringify({ scenario, times, summary }, null, 2));
    console.log(`scenarioValid('${scenario}') =>`, JSON.stringify(verdict));
    process.exitCode = verdict.valid ? 0 : 1;
  } finally {
    load?.stop();
    if (app) await stopApp(app);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
