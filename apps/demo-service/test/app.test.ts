import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { FORBIDDEN_LOG_PHRASES } from '@traceops/contracts';
import { createApp, type Logger } from '../src/app';
import type { Fault } from '../src/config';

type Line = { level: string; obj: Record<string, unknown>; msg: string };

/** A pool client that reports `stock` for the stock check and counts release() calls. */
function fakeClient(stock: number | null) {
  const state = { released: 0 };
  const client = {
    query: async (sql: string) => {
      if (/SELECT stock/.test(sql)) return { rows: stock === null ? [] : [{ stock }] };
      return { rows: [] };
    },
    release: () => {
      state.released++;
    },
  } as unknown as PoolClient;
  return { client, state };
}

let server: Server | undefined;
afterEach(() => server?.close());

async function start(fault: Fault, acquire: () => Promise<PoolClient>) {
  const lines: Line[] = [];
  const mk = (level: string) => (obj: object, msg: string) => lines.push({ level, obj: obj as Record<string, unknown>, msg });
  const log: Logger = { info: mk('info'), warn: mk('warn'), error: mk('error') };
  const app = createApp({ acquire, log, fault, cpuIter: 1000 });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const order = (productId: number) =>
    fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId }) });
  return { base, lines, order };
}

describe('POST /orders insufficient stock (409)', () => {
  it.each<[Fault, number]>([
    ['none', 1],
    ['cpu_burn', 1],
    ['pool_leak', 0],
  ])('FAULT=%s releases the connection %i time(s)', async (fault, expectedReleases) => {
    const { client, state } = fakeClient(0);
    const { order, lines } = await start(fault, async () => client);
    const res = await order(1);
    expect(res.status).toBe(409);
    expect(state.released).toBe(expectedReleases);
    expect(lines.some((l) => l.level === 'warn' && l.msg === 'order rejected' && l.obj.status === 409)).toBe(true);
  });

  it('a successful order always releases, even under pool_leak', async () => {
    const { client, state } = fakeClient(10);
    const { order } = await start('pool_leak', async () => client);
    expect((await order(6)).status).toBe(201);
    expect(state.released).toBe(1);
  });
});

describe('POST /orders: no accidental leak path', () => {
  /** A client whose stock check throws (e.g. a DB error), counting release() calls. */
  function throwingClient() {
    const state = { released: 0 };
    const client = {
      query: async (sql: string) => {
        if (/SELECT stock/.test(sql)) throw new Error('connection terminated unexpectedly');
        return { rows: [] };
      },
      release: () => { state.released++; },
    } as unknown as PoolClient;
    return { client, state };
  }

  it.each<Fault>(['none', 'cpu_burn', 'pool_leak'])('stock-check query throws under FAULT=%s → 500 and the client is released', async (fault) => {
    const { client, state } = throwingClient();
    const { order, lines } = await start(fault, async () => client);
    expect((await order(1)).status).toBe(500);
    expect(state.released).toBe(1);
    expect(lines.some((l) => l.msg === 'request failed' && l.obj.status === 500)).toBe(true);
  });

  it('the only leak is the 409 path under pool_leak; under none the 409 releases', async () => {
    const leak = fakeClient(0);
    expect((await (await start('pool_leak', async () => leak.client)).order(1)).status).toBe(409);
    expect(leak.state.released).toBe(0);
    server?.close();
    const ok = fakeClient(0);
    expect((await (await start('none', async () => ok.client)).order(1)).status).toBe(409);
    expect(ok.state.released).toBe(1);
  });
});

describe('error handler', () => {
  it('turns an acquire failure into 500 + `request failed` with err passed as `err`', async () => {
    const failure = new Error('timeout exceeded when trying to connect');
    const { base, lines } = await start('none', async () => {
      throw failure;
    });
    const res = await fetch(`${base}/products`);
    expect(res.status).toBe(500);
    const failed = lines.find((l) => l.msg === 'request failed');
    expect(failed?.level).toBe('error');
    expect(failed?.obj.err).toBe(failure);
    expect(failed?.obj.status).toBe(500);
    expect(failed?.obj.route).toBe('/products');
    // 5xx is logged once, by the error handler, not also as `request completed`
    expect(lines.filter((l) => l.msg === 'request completed')).toHaveLength(0);
  });
});

describe('request logging', () => {
  it('logs completed requests with route, status and duration_ms', async () => {
    const { base, lines } = await start('none', async () => fakeClient(1).client);
    await fetch(`${base}/healthz`);
    await new Promise((r) => setTimeout(r, 20));
    const done = lines.find((l) => l.msg === 'request completed');
    expect(done?.obj).toMatchObject({ route: '/healthz', status: 200 });
    expect(typeof done?.obj.duration_ms).toBe('number');
  });

  it('no log line names the cause (FORBIDDEN_LOG_PHRASES), under any fault', async () => {
    for (const fault of ['none', 'pool_leak', 'cpu_burn'] as const) {
      const { base, lines, order } = await start(fault, async () => fakeClient(0).client);
      await order(1);
      await fetch(`${base}/healthz`);
      server?.close();
      const text = lines.map((l) => `${l.msg} ${JSON.stringify(l.obj)}`).join('\n');
      for (const phrase of FORBIDDEN_LOG_PHRASES) expect(text).not.toMatch(phrase);
    }
  });
});
