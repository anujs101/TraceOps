import { describe, expect, it } from 'vitest';
import { classifyToken, findUnboundQuantities, placeholders, valueMatches } from '../src/quantities.ts';

const CONTEXT = ['500', '409', '1.0.1']; // status codes / versions present in evidence

describe('V3: legitimate technical language is NOT flagged', () => {
  it.each([
    'p95 latency rose to {p95_peak} after the deploy',
    'HTTP 500 responses increased',
    '5xx ratio exceeded the threshold',
    'service_version changed from 1.0.0 to 1.0.1',
    'v1.0.1 was deployed shortly before the incident',
    'requests to /orders returned 409 when stock was insufficient',
    'db_client_connection_count{state="used"} stayed at {used_max}',
    'see ev_3 and ev_12 for the raw series',
    'p99 event-loop delay stayed near {el_p99}',
    'connections in use reached {used_max}/{pool_max}',
    'HTTP/1.1 requests',
    'the pg-pool error "timeout exceeded when trying to connect" appears in logs',
  ])('%s', (s) => {
    expect(findUnboundQuantities(s, [...CONTEXT, '1.0.0']).filter((f) => f.kind === 'unbound_quantity')).toEqual([]);
  });
});

describe('V3: invented quantities ARE flagged', () => {
  it.each([
    ['connections in use reached 10 of 10', ['10', '10']],
    ['p95 latency was 2.4s', ['2.4s']],
    ['error ratio peaked at 21%', ['21%']],
    ['wait time rose to 950ms', ['950ms']],
    ['about 1,000 requests failed', ['1,000']],
    ['latency increased 3x', ['3x']],
    ['HTTP 503 responses increased', ['503']], // 503 not in evidence context
  ])('%s', (s, tokens) => {
    expect(findUnboundQuantities(s, CONTEXT).filter((f) => f.kind === 'unbound_quantity').map((f) => f.token)).toEqual(tokens);
  });
});

describe('time literals are warnings, not quantities', () => {
  it('flags clock times as time_literal', () => {
    expect(findUnboundQuantities('errors began at 18:03', CONTEXT)).toEqual([{ token: '18:03', kind: 'time_literal' }]);
  });
});

describe('token classes', () => {
  it.each([
    ['p95', 'identifier'], ['5xx', 'identifier'], ['v1.0.1', 'identifier'], ['ev_3', 'identifier'],
    ['/orders', 'word'], ['{used_max}', 'placeholder'], ['10', 'quantity'], ['0.47', 'quantity'],
    ['2s', 'quantity'], ['(10)', 'quantity'], ['10.', 'quantity'],
  ])('%s → %s', (t, cls) => expect(classifyToken(t).cls).toBe(cls));
});

describe('placeholders', () => {
  it('extracts keys', () => expect(placeholders('{a} of {b_max}')).toEqual(['a', 'b_max']));
});

describe('V2: value matching allows honest rounding only', () => {
  it.each([
    [0.4684, 0.4684, true], [0.47, 0.4684, true], [0.5, 0.4684, true], [30, 31, true],
    [0.05, 0.052, true], [10, 10, true],
    [0.4, 0.4684, false], [0.48, 0.4684, false], [11, 10, false], [5.2, 0.052, false], // percent vs ratio rejected
    [Number.NaN, 1, false],
  ])('claimed %s vs actual %s → %s', (c, a, ok) => expect(valueMatches(c, a)).toBe(ok));
});
