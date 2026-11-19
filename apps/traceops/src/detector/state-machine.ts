/**
 * Per-rule state machine (detection.md §3), pure and in memory:
 *   ok → pending(n) → firing → recovering(n) → ok
 * A breach while recovering → firing; OK while pending → ok.
 * Missing data (empty, NaN, query error) is NOT an observation: no transition, ever.
 * `since` is the first breaching evaluation, carried through pending → firing → recovering.
 */
export type RulePhase =
  | { phase: 'ok' }
  | { phase: 'pending'; n: number; since: string }
  | { phase: 'firing'; since: string }
  | { phase: 'recovering'; n: number; since: string };

export type Observation = 'breach' | 'ok' | 'missing';

export type Transition = 'none' | 'to_pending' | 'to_ok' | 'to_firing' | 'to_recovering';

export type Thresholds = { fire_after: number; resolve_after: number };

export const OK: RulePhase = { phase: 'ok' };

/** `at` is the IsoUtcMs time of this evaluation. */
export function step(state: RulePhase, obs: Observation, cfg: Thresholds, at: string): { state: RulePhase; transition: Transition } {
  if (obs === 'missing') return { state, transition: 'none' };

  if (obs === 'breach') {
    switch (state.phase) {
      case 'ok':
        return cfg.fire_after <= 1
          ? { state: { phase: 'firing', since: at }, transition: 'to_firing' }
          : { state: { phase: 'pending', n: 1, since: at }, transition: 'to_pending' };
      case 'pending': {
        const n = state.n + 1;
        return n >= cfg.fire_after
          ? { state: { phase: 'firing', since: state.since }, transition: 'to_firing' }
          : { state: { phase: 'pending', n, since: state.since }, transition: 'none' };
      }
      case 'firing':
        return { state, transition: 'none' };
      case 'recovering': // breach while recovering: straight back to firing, same episode
        return { state: { phase: 'firing', since: state.since }, transition: 'to_firing' };
    }
  }

  switch (state.phase) {
    case 'ok':
      return { state, transition: 'none' };
    case 'pending': // OK while pending
      return { state: OK, transition: 'to_ok' };
    case 'firing':
      return cfg.resolve_after <= 1
        ? { state: OK, transition: 'to_ok' }
        : { state: { phase: 'recovering', n: 1, since: state.since }, transition: 'to_recovering' };
    case 'recovering': {
      const n = state.n + 1;
      return n >= cfg.resolve_after
        ? { state: OK, transition: 'to_ok' }
        : { state: { phase: 'recovering', n, since: state.since }, transition: 'none' };
    }
  }
}

/** op from RuleConfig; NaN never breaches (callers treat NaN as missing before this). */
export function breaches(op: '>' | '<', observed: number, threshold: number): boolean {
  return op === '>' ? observed > threshold : observed < threshold;
}
