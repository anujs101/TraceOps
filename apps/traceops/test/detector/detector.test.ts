import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Incident } from '@traceops/contracts';
import { PgInvestigationStore } from '../../src/db/store.ts';
import { loadRuleConfig } from '../../src/detector/config.ts';
import { Detector } from '../../src/detector/detector.ts';
import { IncidentManager, fingerprintOf } from '../../src/detector/incidents.ts';
import { enqueueJob } from '../../src/queue/enqueue.ts';
import { DB_URL, createTestDb, seedIncident, type TestDb } from '../db/helpers.ts';
import { FixtureProm, sampleValue, type Mode } from './fixture-prom.ts';

const T0 = Date.UTC(2026, 10, 16, 18, 25, 0);
const at = (i: number) => new Date(T0 + i * 15_000);
const iso = (i: number) => at(i).toISOString();

describe.skipIf(!DB_URL)('detector against real Postgres (fixture-backed Prometheus)', () => {
  let db: TestDb;
  let store: PgInvestigationStore;
  const config = loadRuleConfig();
  beforeAll(async () => { db = await createTestDb(); store = new PgInvestigationStore(db.pool); });
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => { await db.pool.query('TRUNCATE incidents, investigation_jobs CASCADE'); });

  const make = (prom: FixtureProm, incidents?: IncidentManager) =>
    new Detector({ config, pool: db.pool, prometheusUrl: 'http://prom.test', fetch: prom.fetch, log: () => {}, incidents });

  /** One tick per [latency, error] pair, 15 s apart, starting at tick index `from`. */
  async function drive(d: Detector, prom: FixtureProm, seq: [Mode, Mode][], from = 0) {
    for (const [i, [l, e]] of seq.entries()) { prom.set(l, e); await d.tick(at(from + i)); }
  }
  const jobs = async () => (await db.pool.query('SELECT incident_id, idempotency_key, status FROM investigation_jobs ORDER BY created_at')).rows;
  const BL: [Mode, Mode] = ['breach', 'ok']; // latency only
  const OKS: [Mode, Mode] = ['ok', 'ok'];

  it('does not open on a single breach (pending), opens at fire_after with one job in the same go', async () => {
    const prom = new FixtureProm(); const d = make(prom);
    await drive(d, prom, [BL]);
    expect(await store.listIncidents()).toEqual([]);
    expect(d.phaseOf('http-latency-p95').phase).toBe('pending');

    await drive(d, prom, [BL], 1);
    const [inc] = await store.listIncidents();
    expect(Incident.safeParse(inc).success).toBe(true);
    expect(inc).toMatchObject({
      status: 'open', severity: 'warning', service: 'demo-service', group: 'http-slo', reopen_count: 0, resolved_at: null,
      fingerprint: fingerprintOf('demo-service', 'http-slo'),
      started_at: iso(0), // first breaching evaluation
      detected_at: iso(1), // fire_after reached
      trigger: [{ rule_id: 'http-latency-p95', query: 'latency_p95', threshold: 1, observed: sampleValue('latency_p95', 'breach'), at: iso(1) }],
    });
    expect(await jobs()).toEqual([{ incident_id: inc!.id, idempotency_key: `incident:${inc!.id}:auto`, status: 'queued' }]);
  });

  it('a one-evaluation blip never opens an incident', async () => {
    const prom = new FixtureProm(); const d = make(prom);
    await drive(d, prom, [BL, OKS, BL, OKS, BL, OKS]);
    expect(await store.listIncidents()).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it('a second rule firing updates trigger and severity (critical) on the same incident; no second job', async () => {
    const prom = new FixtureProm(); const d = make(prom);
    await drive(d, prom, [BL, BL]);
    await drive(d, prom, [['breach', 'breach'], ['breach', 'breach']], 2);
    const list = await store.listIncidents();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ severity: 'critical', started_at: iso(0), status: 'open' });
    expect(list[0]!.trigger.map((t) => t.rule_id).sort()).toEqual(['http-error-ratio', 'http-latency-p95']);
    expect(list[0]!.trigger.find((t) => t.rule_id === 'http-error-ratio')).toMatchObject({ observed: sampleValue('error_ratio_5xx', 'breach'), threshold: 0.05 });
    expect(await jobs()).toHaveLength(1);
  });

  it('resolves only when EVERY rule is ok, after resolve_after OKs; resolved_at is that evaluation', async () => {
    const prom = new FixtureProm(); const d = make(prom);
    await drive(d, prom, [['breach', 'breach'], ['breach', 'breach']]);
    // latency recovers, error ratio keeps firing: incident stays open however long
    await drive(d, prom, Array(8).fill(['ok', 'breach']), 2);
    expect((await store.listIncidents())[0]!.status).toBe('open');
    // error ratio recovers too: resolves on its 4th consecutive OK, not before
    await drive(d, prom, [OKS, OKS, OKS], 10);
    expect((await store.listIncidents())[0]!.status).toBe('open');
    await drive(d, prom, [OKS], 13);
    expect((await store.listIncidents())[0]).toMatchObject({ status: 'resolved', resolved_at: iso(13) });
  });

  describe('missing data (empty, NaN, query error, timeout) never transitions and never resolves', () => {
    it.each(['empty', 'nan', 'badquery', 'http500'] as Mode[])('%s while firing: incident stays open', async (gap) => {
      const prom = new FixtureProm(); const d = make(prom);
      await drive(d, prom, [BL, BL]);
      await drive(d, prom, Array(20).fill([gap, gap]), 2); // 5 minutes of gaps, >> resolve_after
      expect((await store.listIncidents())[0]).toMatchObject({ status: 'open', resolved_at: null });
      expect(d.phaseOf('http-latency-p95').phase).toBe('firing');
      expect(d.missingCounts()).toEqual({ 'http-latency-p95': 20, 'http-error-ratio': 20 });
    });

    it('gaps in the middle of a recovery neither reset nor advance it', async () => {
      const prom = new FixtureProm(); const d = make(prom);
      await drive(d, prom, [BL, BL, OKS, OKS]); // recovering(2)
      await drive(d, prom, Array(10).fill(['empty', 'empty']), 4);
      expect((await store.listIncidents())[0]!.status).toBe('open');
      await drive(d, prom, [OKS], 14); // 3rd OK
      expect((await store.listIncidents())[0]!.status).toBe('open');
      await drive(d, prom, [OKS], 15); // 4th OK
      expect((await store.listIncidents())[0]!.status).toBe('resolved');
    });

    it('a rule that has never had data never opens an incident', async () => {
      const prom = new FixtureProm(); const d = make(prom);
      await drive(d, prom, Array(10).fill(['empty', 'nan']));
      expect(await store.listIncidents()).toEqual([]);
    });
  });

  it('a breach while recovering returns to firing on the same incident', async () => {
    const prom = new FixtureProm(); const d = make(prom);
    await drive(d, prom, [BL, BL, OKS, OKS, BL]);
    expect(d.phaseOf('http-latency-p95').phase).toBe('firing');
    const list = await store.listIncidents();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'open', reopen_count: 0 });
  });

  describe('reopen (reopen_window_s = 300)', () => {
    const resolveAt = async (prom: FixtureProm, d: Detector) => {
      await drive(d, prom, [BL, BL, OKS, OKS, OKS, OKS]); // resolved at tick 5
      expect((await store.listIncidents())[0]!.status).toBe('resolved');
    };

    it('firing again within the window reopens the SAME incident (reopen_count++), and the contract-literal job key enqueues nothing', async () => {
      const prom = new FixtureProm(); const d = make(prom);
      await resolveAt(prom, d);
      const [orig] = await store.listIncidents();
      await drive(d, prom, [BL, BL], 6 + 4); // ~60-75 s after resolve
      const list = await store.listIncidents();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: orig!.id, status: 'open', reopen_count: 1, resolved_at: null, started_at: orig!.started_at });
      expect(await jobs()).toHaveLength(1); // no re-investigation (see docs/proposals/detection-reopen-job-key.md)
    });

    it('a second reopen increments again', async () => {
      const prom = new FixtureProm(); const d = make(prom);
      await resolveAt(prom, d);
      await drive(d, prom, [BL, BL, OKS, OKS, OKS, OKS, BL, BL], 6);
      expect((await store.listIncidents())[0]).toMatchObject({ status: 'open', reopen_count: 2 });
    });

    it('firing after the window opens a NEW incident with its own job', async () => {
      const prom = new FixtureProm(); const d = make(prom);
      await resolveAt(prom, d); // resolved at iso(5)
      const gap = 5 + 300 / 15 + 2; // > 300 s after resolve
      await drive(d, prom, [BL, BL], gap);
      const list = await store.listIncidents();
      expect(list).toHaveLength(2);
      expect(list.map((i) => i.status).sort()).toEqual(['open', 'resolved']);
      expect((await jobs()).map((j) => j.idempotency_key).sort()).toEqual(list.map((i) => `incident:${i.id}:auto`).sort());
    });
  });

  describe('open + enqueue are one transaction', () => {
    it('if enqueue fails, no incident row survives; the next tick retries and succeeds', async () => {
      let fail = true;
      const mgr = new IncidentManager(db.pool, async (q, id, key) => { if (fail) throw new Error('enqueue boom'); return enqueueJob(q, id, key); });
      const prom = new FixtureProm(); const d = make(prom, mgr);
      await drive(d, prom, [BL, BL]); // reaches firing; the write fails
      expect(await store.listIncidents()).toEqual([]);
      expect(await jobs()).toEqual([]);
      fail = false;
      await drive(d, prom, [BL], 2); // still firing: the owed open is retried even though no new transition occurs
      expect(await store.listIncidents()).toHaveLength(1);
      expect(await jobs()).toHaveLength(1);
    });

    it('two detectors firing at the same instant produce exactly one open incident and one job', async () => {
      const prom = new FixtureProm();
      const ds = [make(prom), make(prom), make(prom)];
      for (const d of ds) { prom.set(...BL); await d.tick(at(0)); }
      prom.set(...BL);
      await Promise.all(ds.map((d) => d.tick(at(1))));
      expect(await store.listIncidents()).toHaveLength(1);
      expect(await jobs()).toHaveLength(1);
    });
  });

  describe('owed open survives a failed write; trigger/severity merge (review fix)', () => {
    /** An IncidentManager whose openOrUpdate throws while `failing` is set (real DB otherwise). */
    const flaky = () => {
      const mgr = new IncidentManager(db.pool) as IncidentManager & { failing: boolean };
      const real = mgr.openOrUpdate.bind(mgr);
      mgr.failing = true;
      mgr.openOrUpdate = async (req) => { if (mgr.failing) throw new Error('db down'); return real(req); };
      return mgr;
    };

    it('write fails at the fire tick, rule is already recovering when it is retried: opens with detected_at = fire tick', async () => {
      const mgr = flaky(); const prom = new FixtureProm(); const d = make(prom, mgr);
      await drive(d, prom, [BL, BL]); // fires at tick 1; write fails
      expect(await store.listIncidents()).toEqual([]);
      mgr.failing = false;
      await drive(d, prom, [OKS], 2); // rule is now recovering(1): no longer firing
      expect(d.phaseOf('http-latency-p95').phase).toBe('recovering');
      const [inc] = await store.listIncidents();
      expect(inc).toMatchObject({ status: 'open', severity: 'warning', started_at: iso(0), detected_at: iso(1) });
      expect(inc!.trigger.map((t) => t.rule_id)).toEqual(['http-latency-p95']);
      expect(await jobs()).toHaveLength(1);
    });

    it('group fully recovers before any write succeeds: it opens (fire tick) and then resolves', async () => {
      const mgr = flaky(); const prom = new FixtureProm(); const d = make(prom, mgr);
      await drive(d, prom, [BL, BL, OKS, OKS, OKS]); // still failing; recovering(3)
      expect(await store.listIncidents()).toEqual([]);
      mgr.failing = false;
      await drive(d, prom, [OKS], 5); // 4th OK → ok
      const [inc] = await store.listIncidents();
      expect(inc).toMatchObject({ status: 'resolved', detected_at: iso(1), started_at: iso(0), resolved_at: iso(5) });
      expect(await jobs()).toHaveLength(1);
    });

    it('a rule that recovers and re-fires while its sibling keeps firing never loses a trigger or downgrades severity', async () => {
      const prom = new FixtureProm(); const d = make(prom);
      await drive(d, prom, [['breach', 'breach'], ['breach', 'breach']]); // critical
      await drive(d, prom, [['ok', 'breach'], ['ok', 'breach']], 2); // latency recovering
      await drive(d, prom, [['breach', 'breach'], ['breach', 'breach']], 4); // latency back to firing
      const [inc] = await store.listIncidents();
      expect(inc!.severity).toBe('critical');
      expect(inc!.trigger.map((t) => t.rule_id).sort()).toEqual(['http-error-ratio', 'http-latency-p95']);
    });

    it('after a restart, seeded recovering(0) rules do not count as fired: a lone firing rule neither downgrades nor drops the stored trigger', async () => {
      const id = await seedIncident(db.pool, { service: 'demo-service', group: 'http-slo', severity: 'critical' });
      const before = (await store.getIncident(id))!.trigger;
      const prom = new FixtureProm(); const d = make(prom);
      await d.seedFromOpenIncidents();
      await drive(d, prom, [BL]); // latency breaches straight back to firing; error ratio never fires
      const inc = (await store.getIncident(id))!;
      expect(inc.severity).toBe('critical'); // not downgraded to warning
      const ids = inc.trigger.map((t) => t.rule_id);
      expect(ids).toContain('http-latency-p95');
      for (const t of before) expect(ids).toContain(t.rule_id);
    });
  });

  describe('restart: state is rebuilt by re-evaluating', () => {
    it('with an open incident, a fresh detector needs resolve_after OKs (not 1) to resolve it', async () => {
      const id = await seedIncident(db.pool, { service: 'demo-service', group: 'http-slo' });
      const prom = new FixtureProm(); const d = make(prom);
      await d.seedFromOpenIncidents();
      await drive(d, prom, [OKS, OKS, OKS]);
      expect((await store.getIncident(id))!.status).toBe('open');
      await drive(d, prom, [OKS], 3);
      expect((await store.getIncident(id))!.status).toBe('resolved');
    });

    it('re-firing after a restart updates the existing open incident instead of duplicating it', async () => {
      const id = await seedIncident(db.pool, { service: 'demo-service', group: 'http-slo' });
      const prom = new FixtureProm(); const d = make(prom);
      await d.seedFromOpenIncidents();
      await drive(d, prom, [['breach', 'breach']]);
      const list = await store.listIncidents();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id, status: 'open', severity: 'critical' });
      expect(list[0]!.trigger).toHaveLength(2);
    });

    it('without seeding, a fresh detector that re-fires still cannot create a duplicate', async () => {
      const id = await seedIncident(db.pool, { service: 'demo-service', group: 'http-slo' });
      const prom = new FixtureProm(); const d = make(prom);
      await drive(d, prom, [BL, BL]);
      expect((await store.listIncidents()).map((i) => i.id)).toEqual([id]);
    });
  });

  it('start() runs a first tick immediately and stop() halts the loop', async () => {
    const prom = new FixtureProm(); prom.set(...BL);
    const d = make(prom);
    await d.start();
    await new Promise((r) => setTimeout(r, 100));
    await d.stop();
    const n = prom.requests.length;
    expect(n).toBe(2); // one tick = one instant query per rule
    await new Promise((r) => setTimeout(r, 100));
    expect(prom.requests.length).toBe(n);
  });
});
