/** Display formatting, on values taken from the real S1 run (docs/runs/s1-20261119T104115Z). */
import { describe, expect, it } from 'vitest';
import { duration, elapsed, exact, formatValue, formatWithUnit, offset, sig3 } from '../src/lib/format.ts';

describe('formatValue', () => {
  it.each([
    // [value, unit, text, displayUnit]
    [0.5975539184166275, 'ratio', '59.8', '%'], // ev_2 error_ratio_5xx max
    [1, 'ratio', '100', '%'],
    [0, 'ratio', '0', '%'],
    [0.32614028324792327, 'ratio', '32.6', '%'],
    [2.3744883136257697, 's', '2.37', 's'], // ev_1 latency_p95 max
    [0.009490402125541761, 's', '9.49', 'ms'], // ev_1 first
    [0.004866531027466937, 's', '4.87', 'ms'], // ev_8 db_operation_p95 max
    [0.019382271, 's', '19.4', 'ms'], // ev_11 eventloop_delay_p99 max
    [0, 's', '0', 's'],
    [28.045693590149916, 'req/s', '28.0', 'req/s'], // ev_12 avg
    [16.672925206340743, 'timeouts/s', '16.7', 'timeouts/s'], // ev_7 max
    [10, 'connections', '10', 'connections'], // ev_9 max
    [4.3, 'connections', '4.30', 'connections'],
    [60, 'requests', '60', 'requests'], // ev_6 max
    [2848, 'count', '2,848', 'count'], // ev_4 info.sum
    [6545.463523685551, 'count', '6,545', 'count'],
    [0.47214464935568634, null, '0.472', ''],
  ])('%s %s → %s %s', (v, unit, text, u) => {
    expect(formatValue(v as number, unit as string | null)).toEqual({ text, unit: u });
  });

  it('never alters the stored value: exact() is the shortest round-trip form', () => {
    for (const v of [0.5975539184166275, 2.3744883136257697, 10, 0.004817135862913096]) {
      expect(Number(exact(v))).toBe(v);
    }
  });

  it('joins units for display', () => {
    expect(formatWithUnit(0.5975539184166275, 'ratio')).toBe('59.8%');
    expect(formatWithUnit(2.3744883136257697, 's')).toBe('2.37 s');
    expect(formatWithUnit(10, 'connections')).toBe('10');
    expect(formatWithUnit(10, 'connections', true)).toBe('10 connections');
  });

  it('sig3 rounds to ~3 significant figures', () => {
    expect(sig3(9.4904)).toBe('9.49');
    expect(sig3(123.6)).toBe('124');
    expect(sig3(-0.0123456)).toBe('-0.0123');
  });
});

describe('durations', () => {
  it('formats spans', () => {
    expect(duration(37_771)).toBe('37.8 s'); // detected_at → finished_at in the S1 run
    expect(duration(850)).toBe('850 ms');
    expect(duration(135_286)).toBe('2 m 15 s');
    expect(duration(3_900_000)).toBe('1 h 5 m');
    expect(elapsed(42_000)).toBe('0:42');
    expect(elapsed(3_725_000)).toBe('1:02:05');
    expect(offset('2026-11-19T10:44:15.403Z', '2026-11-19T10:44:30.403Z')).toBe('+15.0 s');
  });
});
