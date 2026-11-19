import { startLoad } from './load';

const rps = Number(process.env.RPS ?? 30);
const seconds = Number(process.env.SECONDS ?? 60);
const h = startLoad({ base: process.env.BASE, rps, lowStockShare: Number(process.env.LOW_STOCK_SHARE ?? 0.02) });
const report = setInterval(() => console.log(new Date().toISOString(), JSON.stringify(h.stats)), 10000);
setTimeout(() => {
  h.stop();
  setTimeout(() => {
    clearInterval(report);
    console.log('final', JSON.stringify(h.stats));
    process.exit(0);
  }, 6000); // let in-flight requests (5 s timeout) settle
}, seconds * 1000);
