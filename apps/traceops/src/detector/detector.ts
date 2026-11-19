import type pg from 'pg';
import { toIsoUtcMs, type RuleConfig } from '@traceops/contracts';
import { IncidentManager, type OpenResult, type TriggerEntry } from './incidents.ts';
import { queryInstant, type FetchLike, type InstantResult } from './prom-client.ts';
import { breaches, OK, step, type Observation, type RulePhase } from './state-machine.ts';

type Rule = RuleConfig['rules'][number];
export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export type DetectorOptions = {
  config: RuleConfig;
  pool: pg.Pool;
  prometheusUrl: string;
  fetch?: FetchLike;
  /** replace the whole query path (tests of the loop only; default = queryInstant) */
  evaluate?: (rule: Rule) => Promise<InstantResult>;
  incidents?: IncidentManager;
  now?: () => Date;
  log?: LogFn;
};

type RuleRuntime = { phase: RulePhase; lastBreach: { observed: number; at: string } | null };

const groupKey = (r: Pick<Rule, 'service' | 'group'>) => `${r.service}:${r.group}`;

/**
 * Deterministic detection (no LLM): evaluate every rule each interval, advance its
 * state machine, and open / update / resolve / reopen one incident per (service, group).
 */
export class Detector {
  private readonly cfg: RuleConfig;
  private readonly incidents: IncidentManager;
  private readonly now: () => Date;
  private readonly log: LogFn;
  private readonly runtime = new Map<string, RuleRuntime>();
  private readonly byGroup = new Map<string, Rule[]>();
  /** DB work that failed or is owed; retried on the next tick (the state machine will not re-emit the transition). */
  private readonly owed = new Map<string, 'open' | 'resolve'>();
  private readonly missing = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly o: DetectorOptions) {
    this.cfg = o.config;
    this.incidents = o.incidents ?? new IncidentManager(o.pool);
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? ((level, msg, f) => console[level === 'info' ? 'log' : level](`[detector] ${msg}`, f ?? ''));
    for (const r of this.cfg.rules) {
      this.runtime.set(r.id, { phase: OK, lastBreach: null });
      const g = this.byGroup.get(groupKey(r)) ?? [];
      g.push(r);
      this.byGroup.set(groupKey(r), g);
    }
  }

  /** How many evaluations of each rule returned missing data (detection.md §3: counted). */
  missingCounts(): Record<string, number> { return Object.fromEntries(this.missing); }
  phaseOf(ruleId: string): RulePhase { return this.runtime.get(ruleId)!.phase; }

  /**
   * State is in memory and rebuilt by re-evaluating. For groups that already have an
   * open incident (restart), start their rules as `recovering(0)`: the incident then
   * resolves only after `resolve_after` consecutive OK evaluations, and a breach goes
   * straight back to firing. Without this, the first OK after a restart would resolve it.
   */
  async seedFromOpenIncidents(): Promise<void> {
    const at = toIsoUtcMs(this.now());
    for (const g of await this.incidents.openGroups()) {
      for (const r of this.byGroup.get(`${g.service}:${g.group}`) ?? []) {
        this.runtime.get(r.id)!.phase = { phase: 'recovering', n: 0, since: at };
      }
    }
  }

  /** One evaluation round. `at` is the time of this round (injectable for tests). */
  async tick(at: Date = this.now()): Promise<void> {
    const atIso = toIsoUtcMs(at);
    const evals = await Promise.all(this.cfg.rules.map(async (rule) => ({ rule, res: await this.evaluate(rule) })));

    for (const { rule, res } of evals) {
      const rt = this.runtime.get(rule.id)!;
      let obs: Observation = 'missing';
      if (res.kind === 'value') obs = breaches(rule.op, res.value, rule.threshold) ? 'breach' : 'ok';
      else {
        this.missing.set(rule.id, (this.missing.get(rule.id) ?? 0) + 1);
        this.log('warn', 'missing data', { rule: rule.id, reason: res.reason, detail: res.detail, total: this.missing.get(rule.id) });
      }
      const { state, transition } = step(rt.phase, obs, this.cfg.evaluation, atIso);
      rt.phase = state;
      if (obs === 'breach' && res.kind === 'value') rt.lastBreach = { observed: res.value, at: atIso };
      if (transition !== 'none') this.log('info', 'rule transition', { rule: rule.id, transition, observed: res.kind === 'value' ? res.value : null });
      const key = groupKey(rule);
      if (transition === 'to_firing') this.owed.set(key, 'open');
      else if (transition === 'to_ok' && !this.owed.has(key)) this.owed.set(key, 'resolve');
    }

    for (const key of [...this.owed.keys()]) await this.settle(key, atIso);
  }

  private async settle(key: string, atIso: string): Promise<void> {
    const rules = this.byGroup.get(key)!;
    const owed = this.owed.get(key)!;
    const firing = rules.filter((r) => this.runtime.get(r.id)!.phase.phase === 'firing');
    const allOk = rules.every((r) => this.runtime.get(r.id)!.phase.phase === 'ok');
    // an owed open whose rules have all recovered meanwhile (failed write, then recovery) must resolve instead
    const want = owed === 'open' && firing.length === 0 && allOk ? 'resolve' : owed;
    try {
      if (want === 'open' && firing.length > 0) {
        const res = await this.incidents.openOrUpdate(this.openRequest(rules, firing, atIso));
        this.logOpen(key, res);
      } else if (want === 'resolve' && allOk) {
        const id = await this.incidents.resolve(rules[0]!.service, rules[0]!.group, atIso);
        if (id) this.log('info', 'incident resolved', { group: key, incident: id });
      }
      this.owed.delete(key); // done, or no longer applicable
    } catch (e) {
      this.log('error', 'incident write failed; will retry next tick', { group: key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private openRequest(rules: Rule[], firing: Rule[], atIso: string) {
    const trigger: TriggerEntry[] = firing.map((r) => {
      const b = this.runtime.get(r.id)!.lastBreach!;
      return { rule_id: r.id, query: r.query, threshold: r.threshold, observed: b.observed, at: b.at };
    });
    const startedAt = firing
      .map((r) => (this.runtime.get(r.id)!.phase as { since: string }).since)
      .reduce((a, b) => (a < b ? a : b));
    return {
      service: rules[0]!.service, group: rules[0]!.group,
      severity: (firing.length === rules.length ? 'critical' : 'warning') as 'critical' | 'warning', // critical if every rule fired
      startedAt, detectedAt: atIso, trigger, reopenWindowS: this.cfg.evaluation.reopen_window_s,
    };
  }

  private logOpen(key: string, r: OpenResult) {
    this.log('info', `incident ${r.action}`, { group: key, incident: r.incidentId, job: r.jobId });
  }

  private evaluate(rule: Rule): Promise<InstantResult> {
    return this.o.evaluate
      ? this.o.evaluate(rule)
      : queryInstant(this.o.prometheusUrl, rule.query, rule.service, this.cfg.evaluation.query_timeout_s, this.o.fetch);
  }

  // ── loop ────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.seedFromOpenIncidents();
    const loop = () => {
      if (this.stopped) return;
      const t0 = Date.now();
      this.inflight = this.tick()
        .catch((e) => this.log('error', 'tick failed', { error: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          this.inflight = null;
          if (!this.stopped) this.timer = setTimeout(loop, Math.max(0, this.cfg.evaluation.interval_s * 1000 - (Date.now() - t0)));
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight;
  }
}
