import { describe, expect, it } from 'vitest';
import { breaches, OK, step, type Observation, type RulePhase } from '../../src/detector/state-machine.ts';

const CFG = { fire_after: 2, resolve_after: 4 }; // rules.yaml defaults
const T = (i: number) => new Date(Date.UTC(2026, 10, 16, 18, 25, i * 15)).toISOString();

/** Drive a sequence of observations; returns each step's resulting phase name and transition. */
function run(obs: Observation[], cfg = CFG, from: RulePhase = OK) {
  let state = from;
  return obs.map((o, i) => {
    const r = step(state, o, cfg, T(i));
    state = r.state;
    return `${r.state.phase}${'n' in r.state ? `(${r.state.n})` : ''}:${r.transition}`;
  });
}

describe('rule state machine (detection.md §3)', () => {
  it('ok → pending → firing → recovering → ok', () => {
    expect(run(['breach', 'breach', 'breach', 'ok', 'ok', 'ok', 'ok'])).toEqual([
      'pending(1):to_pending', 'firing:to_firing', 'firing:none',
      'recovering(1):to_recovering', 'recovering(2):none', 'recovering(3):none', 'ok:to_ok',
    ]);
  });

  it('a breach while recovering goes straight back to firing', () => {
    expect(run(['breach', 'breach', 'ok', 'ok', 'breach'])).toEqual([
      'pending(1):to_pending', 'firing:to_firing', 'recovering(1):to_recovering', 'recovering(2):none', 'firing:to_firing',
    ]);
  });

  it('after a breach in recovering, resolve_after counts from scratch', () => {
    const seq = run(['breach', 'breach', 'ok', 'ok', 'ok', 'breach', 'ok', 'ok', 'ok']);
    expect(seq.at(-1)).toBe('recovering(3):none'); // 3 OKs after the breach, not 4 in total
  });

  it('OK while pending goes back to ok', () => {
    expect(run(['breach', 'ok'])).toEqual(['pending(1):to_pending', 'ok:to_ok']);
  });

  it('needs fire_after consecutive breaches: an interleaved OK restarts the count', () => {
    expect(run(['breach', 'ok', 'breach'])).toEqual(['pending(1):to_pending', 'ok:to_ok', 'pending(1):to_pending']);
  });

  it.each([
    ['ok', OK],
    ['pending', { phase: 'pending', n: 1, since: T(0) }],
    ['firing', { phase: 'firing', since: T(0) }],
    ['recovering', { phase: 'recovering', n: 2, since: T(0) }],
  ] as [string, RulePhase][])('missing data in %s: no transition, state untouched', (_n, from) => {
    for (const r of run(['missing', 'missing', 'missing', 'missing', 'missing'], CFG, from)) expect(r.endsWith(':none')).toBe(true);
    expect(step(from, 'missing', CFG, T(9))).toEqual({ state: from, transition: 'none' });
  });

  it('missing data never resolves: a firing rule stays firing through any number of gaps', () => {
    let s: RulePhase = { phase: 'firing', since: T(0) };
    for (let i = 0; i < 50; i++) s = step(s, 'missing', CFG, T(i)).state;
    expect(s).toEqual({ phase: 'firing', since: T(0) });
  });

  it('missing data neither advances nor resets a recovery', () => {
    expect(run(['ok', 'missing', 'missing', 'ok', 'missing', 'ok', 'ok'], CFG, { phase: 'firing', since: T(0) })).toEqual([
      'recovering(1):to_recovering', 'recovering(1):none', 'recovering(1):none', 'recovering(2):none',
      'recovering(2):none', 'recovering(3):none', 'ok:to_ok',
    ]);
  });

  it('keeps `since` (the first breaching evaluation) through pending → firing → recovering', () => {
    let s: RulePhase = OK;
    for (const [i, o] of (['breach', 'breach', 'ok'] as Observation[]).entries()) s = step(s, o, CFG, T(i)).state;
    expect(s).toEqual({ phase: 'recovering', n: 1, since: T(0) });
  });

  it('fire_after 1 and resolve_after 1 skip the intermediate phases', () => {
    const c = { fire_after: 1, resolve_after: 1 };
    expect(run(['breach', 'ok'], c)).toEqual(['firing:to_firing', 'ok:to_ok']);
  });
});

describe('breaches()', () => {
  it('compares with the rule op, strictly', () => {
    expect(breaches('>', 1.0000001, 1)).toBe(true);
    expect(breaches('>', 1, 1)).toBe(false);
    expect(breaches('<', 0.5, 1)).toBe(true);
    expect(breaches('<', 1, 1)).toBe(false);
  });
});
