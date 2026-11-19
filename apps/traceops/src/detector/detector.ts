import type pg from 'pg';
import { toIsoUtcMs, type RuleConfig } from '@traceops/contracts';
import { IncidentManager, type OpenRequest, type OpenResult, type TriggerEntry } from './incidents.ts';
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

type RuleRuntime = { phase: RulePhase };
/**
 * What "fired" means (detection.md §5): reached `firing` during this episode (open → resolve).
 * Rules seeded `recovering(0)` after a restart are not in it until they actually fire.
 */
type Episode = { fired: Map<string, TriggerEntry>; startedAt: string; detectedAt: string };
type Owed = { open: boolean; resolve: boolean };

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
  private readonly owed = new Map<string, Owed>();
  private readonly episodes = new Map<string, Episode>();
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
      this.runtime.set(r.id, { phase: OK });
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
      if (transition !== 'none') this.log('info', 'rule transition', { rule: rule.id, transition, observed: res.kind === 'value' ? res.value : null });
      const key = groupKey(rule);
      if (transition === 'to_firing' && res.kind === 'value') {
        this.recordFired(rule, state as { since: string }, res.value, atIso);
        this.owe(key).open = true;
      } else if (transition === 'to_ok') this.owe(key).resolve = true;
    }

    for (const key of [...this.owed.keys()]) await this.settle(key, atIso);
  }

  private owe(key: string): Owed {
    let o = this.owed.get(key);
    if (!o) this.owed.set(key, (o = { open: false, resolve: false }));
    return o;
  }

  private recordFired(rule: Rule, st: { since: string }, observed: number, atIso: string): void {
    const key = groupKey(rule);
    const ep = this.episodes.get(key) ?? { fired: new Map(), startedAt: st.since, detectedAt: atIso };
    ep.fired.set(rule.id, { rule_id: rule.id, query: rule.query, threshold: rule.threshold, observed, at: atIso });
    if (st.since < ep.startedAt) ep.startedAt = st.since;
    this.episodes.set(key, ep); // detectedAt stays the tick that first reached fire_after
  }

  /**
   * Pay what is owed for one group. An owed open is written from the episode (not from the rules'
   * current phases), so it survives the rule having moved on to recovering/ok before the write
   * succeeded: such a group opens (detected_at = the fire tick) and then resolves.
   * A flag is cleared only after its write succeeds; on a throw both stay for the next tick.
   */
  private async settle(key: string, atIso: string): Promise<void> {
    const rules = this.byGroup.get(key)!;
    const owed = this.owed.get(key)!;
    const allOk = rules.every((r) => this.runtime.get(r.id)!.phase.phase === 'ok');
    try {
      const ep = this.episodes.get(key);
      if (owed.open) {
        if (ep) this.logOpen(key, await this.incidents.openOrUpdate(this.openRequest(rules, ep)));
        owed.open = false;
      }
      if (owed.resolve) {
        if (allOk) {
          const id = await this.incidents.resolve(rules[0]!.service, rules[0]!.group, atIso);
          if (id) this.log('info', 'incident resolved', { group: key, incident: id });
          this.episodes.delete(key);
        }
        owed.resolve = false; // not all ok: the rule that is still active will owe it again when it recovers
      }
      this.owed.delete(key);
    } catch (e) {
      this.log('error', 'incident write failed; will retry next tick', { group: key, error: e instanceof Error ? e.message : String(e) });
    }
  }

  private openRequest(rules: Rule[], ep: Episode): OpenRequest {
    return {
      service: rules[0]!.service, group: rules[0]!.group,
      severity: ep.fired.size === rules.length ? 'critical' : 'warning', // critical if every rule in the group fired
      startedAt: ep.startedAt, detectedAt: ep.detectedAt, trigger: [...ep.fired.values()],
      reopenWindowS: this.cfg.evaluation.reopen_window_s,
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
    try { await this.seedFromOpenIncidents(); } catch (e) { this.stopped = true; throw e; } // allow a retry
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
