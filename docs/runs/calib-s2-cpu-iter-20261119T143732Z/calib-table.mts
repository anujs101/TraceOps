/** Read calib-times.txt and print the calibration table from Prometheus (contract templates). */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderPromql } from '/Users/anujs101/Developer/2027/TraceOps/packages/contracts/src/index.ts';

const S = '/private/tmp/claude-501/-Users-anujs101-Developer-2027-TraceOps/3c5acb41-23bf-479c-99f4-970b4ac318e7/scratchpad';
const rows = readFileSync(`${S}/calib-times.txt`, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number) as [number, number, number]);
async function vals(metric: string, start: number, end: number): Promise<number[]> {
  const u = new URL('http://127.0.0.1:9090/api/v1/query_range');
  u.searchParams.set('query', renderPromql(metric as any, 'demo-service'));
  u.searchParams.set('start', String(start)); u.searchParams.set('end', String(end)); u.searchParams.set('step', '5');
  const j: any = await (await fetch(u)).json();
  return (j.data?.result?.[0]?.values ?? []).map(([, v]: [number, string]) => Number(v)).filter(Number.isFinite);
}
const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '-');
const out: any[] = [];
console.log('CPU_ITER | ELU max | ELU avg | p95 max | p95 min (last 60 s) | 5xx ratio max | pool used max');
for (const [iter, t0, t1] of rows) {
  const a = t0 + 30; // measured part: last 60 s (skip warm-up + rate[1m] fill)
  const elu = await vals('eventloop_utilization', a, t1);
  const p95 = await vals('latency_p95', a, t1);
  const e5 = await vals('error_ratio_5xx', t0, t1);
  const used = await vals('pool_used', t0, t1);
  const r = { cpu_iter: iter, window: { start: new Date(t0 * 1000).toISOString(), end: new Date(t1 * 1000).toISOString(), measured_from: new Date(a * 1000).toISOString() },
    elu_max: Math.max(...elu), elu_avg: elu.reduce((x, y) => x + y, 0) / elu.length, p95_max: Math.max(...p95), p95_min_last60: Math.min(...p95), err5xx_max: Math.max(...e5), pool_used_max: Math.max(...used), points: { elu: elu.length, p95: p95.length } };
  out.push(r);
  console.log(`${iter} | ${f(r.elu_max)} | ${f(r.elu_avg)} | ${f(r.p95_max)} | ${f(r.p95_min_last60)} | ${f(r.err5xx_max)} | ${r.pool_used_max}`);
}
const pick = out.find((r) => r.elu_max >= 0.95 && r.p95_min_last60 >= 1.5 && r.err5xx_max < 0.05);
console.log(`pick (smallest with ELU max >= 0.95, p95 >= 1.5 s sustained over the last 60 s, 5xx ratio max < 0.05): ${pick ? pick.cpu_iter : 'NONE'}`);
writeFileSync(`${S}/calib-table.json`, JSON.stringify({ rows: out, pick: pick?.cpu_iter ?? null }, null, 2));
