import { describe, expect, it } from 'vitest';
import { apiTarget } from '../vite.config.ts';

describe('Vite /api proxy target', () => {
  it('defaults to the real TraceOps API on 4000', () => {
    expect(apiTarget({})).toBe('http://localhost:4000');
  });
  it('follows VITE_API_TARGET (dev API on 4100)', () => {
    expect(apiTarget({ VITE_API_TARGET: 'http://localhost:4100' })).toBe('http://localhost:4100');
  });
});
