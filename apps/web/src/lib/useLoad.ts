import { useCallback, useEffect, useState } from 'react';

export type Load<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** Load once, then re-poll while pollMs(data) returns a number. Keeps the last data on a failed poll. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: (d: T | null) => number | null): Load<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);
  useEffect(() => {
    let live = true;
    run().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (e: unknown) => live && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })),
    );
    return () => { live = false; };
  }, [run, tick]);
  const every = pollMs?.(state.data) ?? null;
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => setTick((n) => n + 1), every);
    return () => clearInterval(t);
  }, [every]);
  const reload = useCallback(() => { setState((s) => ({ ...s, loading: true })); setTick((n) => n + 1); }, []);
  return { ...state, reload };
}

/** Re-render every `ms` while `on` (for running clocks). */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}
