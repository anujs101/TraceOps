import { describe, expect, it } from 'vitest';
import { loadConfig, parseCpuIter, parseFault } from '../src/config';

describe('fault flag parsing', () => {
  it('defaults to none', () => {
    expect(parseFault(undefined)).toBe('none');
    expect(loadConfig({}).fault).toBe('none');
  });
  it('accepts the three contract values', () => {
    for (const f of ['none', 'pool_leak', 'cpu_burn'] as const) expect(parseFault(f)).toBe(f);
  });
  it('rejects anything else at startup', () => {
    expect(() => parseFault('cpu_spike')).toThrow(/invalid FAULT/);
    expect(() => parseFault('')).toThrow(/invalid FAULT/);
  });
  it('CPU_ITER defaults to 400000 (contracts v1.4) and must be a positive integer', () => {
    expect(parseCpuIter(undefined)).toBe(400000);
    expect(parseCpuIter('1000')).toBe(1000);
    expect(() => parseCpuIter('0')).toThrow();
    expect(() => parseCpuIter('abc')).toThrow();
  });
  it('reads SERVICE_VERSION, defaulting to the baseline', () => {
    expect(loadConfig({}).serviceVersion).toBe('1.0.0');
    expect(loadConfig({ SERVICE_VERSION: '1.0.1' }).serviceVersion).toBe('1.0.1');
  });
});
