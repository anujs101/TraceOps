/** Open-loop load generator (scenario-db-pool.md "Load profile"): 80% GET /products, 20% POST /orders. */
export type LoadOptions = {
  base?: string;
  rps?: number; // default 30
  lowStockShare?: number; // share of orders aimed at zero-stock products (ids 1-5); default 0.02
};

export type LoadHandle = {
  stats: { sent: number; codes: Record<string, number>; errors: number };
  stop(): void;
};

const ORDER_SHARE = 0.2;
const ZERO_STOCK_IDS = 5; // db.ts seed: products 1-5 have no stock, 6-50 do

export function startLoad(opts: LoadOptions = {}): LoadHandle {
  const base = opts.base ?? 'http://localhost:8080';
  const rps = opts.rps ?? 30;
  const low = opts.lowStockShare ?? 0.02;
  const stats: LoadHandle['stats'] = { sent: 0, codes: {}, errors: 0 };

  const one = () => {
    stats.sent++;
    const isOrder = Math.random() < ORDER_SHARE;
    const p = isOrder
      ? fetch(`${base}/orders`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            productId:
              Math.random() < low
                ? 1 + Math.floor(Math.random() * ZERO_STOCK_IDS)
                : ZERO_STOCK_IDS + 1 + Math.floor(Math.random() * (50 - ZERO_STOCK_IDS)),
          }),
          signal: AbortSignal.timeout(5000),
        })
      : fetch(`${base}/products`, { signal: AbortSignal.timeout(5000) });
    p.then((r) => {
      stats.codes[r.status] = (stats.codes[r.status] ?? 0) + 1;
      return r.arrayBuffer();
    }).catch(() => {
      stats.errors++;
    });
  };

  // Open loop: requests are issued on a fixed clock regardless of whether earlier ones finished.
  const timer = setInterval(one, 1000 / rps);
  return { stats, stop: () => clearInterval(timer) };
}
