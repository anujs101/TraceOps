// SPIKE ONLY: steady open-loop load. RPS, LOW_STOCK_SHARE, SECONDS via env.
const BASE = process.env.BASE ?? 'http://localhost:8080';
const RPS = Number(process.env.RPS ?? 30);
const LOW = Number(process.env.LOW_STOCK_SHARE ?? 0.02);
const SECONDS = Number(process.env.SECONDS ?? 60);
const stats = { sent: 0, codes: {}, errors: 0 };

function one() {
  stats.sent++;
  const isOrder = Math.random() < 0.2;
  const productId = Math.random() < LOW ? 1 + Math.floor(Math.random() * 5) : 6 + Math.floor(Math.random() * 45);
  const p = isOrder
    ? fetch(`${BASE}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId }), signal: AbortSignal.timeout(5000) })
    : fetch(`${BASE}/products`, { signal: AbortSignal.timeout(5000) });
  p.then((r) => { stats.codes[r.status] = (stats.codes[r.status] ?? 0) + 1; return r.arrayBuffer(); })
   .catch(() => { stats.errors++; });
}
const timer = setInterval(one, 1000 / RPS);
const report = setInterval(() => console.log(new Date().toISOString(), JSON.stringify(stats)), 10000);
setTimeout(() => { clearInterval(timer); setTimeout(() => { clearInterval(report); console.log('final', JSON.stringify(stats)); process.exit(0); }, 6000); }, SECONDS * 1000);
