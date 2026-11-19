import { describe, expect, it } from 'vitest';
import { cleanOrNull, cleanString, redact, truncate } from '../../src/tools/redact.ts';
import { invalidInput, sanitizeBackendError } from '../../src/tools/errors.ts';

// Synthetic corpus: every secret below is fake. Closes contracts VERIFY item 4.
const MUST_REDACT: [string, string][] = [
  ['bearer header', 'upstream said Authorization: Bearer abcDEF123456.ghi-jkl_mno~pqr+stu/vwx= rejected'],
  ['bearer bare', 'retrying with Bearer 0123456789abcdefghij'],
  ['basic auth', 'sent Basic dXNlcjpwYXNzd29yZDEyMzQ1'],
  ['groq key', 'GROQ call failed with key gsk_AbCdEf0123456789AbCdEf0123456789'],
  ['openai-style key', 'bad key sk-proj-AbCdEf0123456789AbCdEf0123'],
  ['github token', 'clone failed ghp_AbCdEf0123456789AbCdEf0123456789abcd'],
  ['aws key id', 'creds AKIAABCDEFGHIJKLMNOP leaked'],
  ['jwt', 'session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk end'],
  ['api_key=', 'GET /v1?api_key=SuperSecretValue123&x=1'],
  ['json token', '{"token": "abc123def456ghi789"}'],
  ['password:', 'login failed password: hunter2hunter2'],
  ['postgres url', 'connect ECONNREFUSED postgres://shop_user:s3cr3tPass@db.internal:5432/shop'],
  ['postgresql url', 'postgresql://admin:p%40ss@10.0.0.5/app failed'],
  ['redis url', 'redis://default:topsecret@cache:6379'],
  ['https url creds', 'GET https://admin:hunter2pass@internal-registry/x failed'],
  ['http url creds', 'proxy http://svc:Pr0xyPassw0rd@proxy.internal:3128 refused'],
  ['ftp url creds', 'upload ftp://deploy:ftpSecret99@files.internal/out.csv failed'],
  ['amqp url creds', 'amqp://guest:rabbitSecret77@mq:5672 closed'],
  ['jdbc url creds', 'jdbc:postgresql://app:jdbcSecret55@db:5432/shop timed out'],
  ['custom scheme creds', 'vault+tls://role:vaultSecret33@vault.internal/v1 denied'],
  ['email', 'order placed by jane.doe+test@example.co.uk today'],
  ['hex 32', 'trace 402ce5e65eda0113982d510db4d99ce4 failed'],
  ['hex 64', 'sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['base64 blob', 'payload QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0FMb25nQmFzZTY0U3RyaW5nMTIzNDU2 end'],
];
const SECRET_FRAGMENTS = [
  'hunter2pass', 'Pr0xyPassw0rd', 'ftpSecret99', 'rabbitSecret77', 'jdbcSecret55', 'vaultSecret33', 'abcDEF123456', '0123456789abcdefghij', 'dXNlcjpwYXNzd29yZDEyMzQ1', 'AbCdEf0123456789', 'AKIAABCDEFGHIJKLMNOP', 'eyJhbGciOiJIUzI1NiJ9',
  'SuperSecretValue123', 'abc123def456ghi789', 'hunter2hunter2', 's3cr3tPass', 'p%40ss', 'topsecret', 'jane.doe', 'example.co.uk',
  '402ce5e65eda0113982d510db4d99ce4', '9f86d081884c7d65', 'QWxhZGRpbjpvcGVuIHNlc2FtZVRoaXNJc0FM',
];

const MUST_SURVIVE = [
  'request failed',
  'timeout exceeded when trying to connect',
  'GET /orders/42 returned 500 in 1830ms',
  'service version v1.0.1 deployed',
  'order 6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f created',
  'HTTP/1.1 409 Conflict on /checkout',
  'db_client_connection_wait_time_seconds_bucket exceeded',
  'connection pool exhausted (max 10)', // diagnostic text, not a secret
  'span 2437afdb9779e093 finished', // 16 hex chars: below the long-hex threshold
  '/api/v1/products/categories/electronics/featured/items',
  'Error: connect ETIMEDOUT',
  'Basic validation failed for pool',
  'Basic configuration missing',
  'GET https://example.com/a/b?x=1 returned 200',
  'upstream http://host:8080/health ok',
  'see https://example.com/users/a:b for details',
];

describe('redact: secrets', () => {
  it.each(MUST_REDACT)('%s', (_name, input) => {
    const out = redact(input);
    expect(out).not.toBe(input);
    for (const frag of SECRET_FRAGMENTS) expect(out).not.toContain(frag);
  });
  it('keeps the useful scheme and host context of a connection string', () => {
    expect(redact('postgres://u:p@db:5432/x')).toBe('postgres://[REDACTED]@db:5432/x');
  });
  it('keeps scheme and host for non-database URLs too', () => {
    expect(redact('https://admin:hunter2@reg.internal/x')).toBe('https://[REDACTED]@reg.internal/x');
  });
  it('is idempotent', () => {
    for (const [, s] of MUST_REDACT) expect(redact(redact(s))).toBe(redact(s));
  });
});

describe('redact: no false positives on diagnostic text', () => {
  it.each(MUST_SURVIVE)('%s', (s) => expect(redact(s)).toBe(s));
});

describe('truncate / cleanString', () => {
  it('leaves short strings alone', () => expect(truncate('abc')).toBe('abc'));
  it('caps at exactly 300 chars including the marker', () => {
    const t = truncate('x'.repeat(1000));
    expect(t).toHaveLength(300);
    expect(t.endsWith('…')).toBe(true);
  });
  it('does not split a surrogate pair', () => {
    const t = truncate('a'.repeat(298) + '😀😀');
    expect(t.length).toBeLessThanOrEqual(300);
    expect(t).not.toMatch(/[\ud800-\udbff]…$/);
  });
  it('redacts before truncating, so a secret straddling the cut cannot leak a prefix', () => {
    const s = 'x'.repeat(280) + ' Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    const out = cleanString(s);
    expect(out).not.toContain('abcdefgh');
    expect(out.length).toBeLessThanOrEqual(300);
  });
  it('cleanOrNull maps empty and missing to null', () => {
    expect(cleanOrNull(undefined)).toBeNull();
    expect(cleanOrNull(null)).toBeNull();
    expect(cleanOrNull('')).toBeNull();
    expect(cleanOrNull('ok')).toBe('ok');
  });
});

describe('error sanitising', () => {
  const f = (kind: any, message: string) => ({ ok: false as const, kind, message });
  it('never echoes backend text: no PromQL, no URLs, no hostnames', () => {
    const nasty = 'prometheus bad_data: invalid parameter "query": 1:10: parse error in sum(rate(http_server_request_duration_seconds_count{service_name="demo-service"}[1m])) at http://prom.internal:9090/api/v1/query_range';
    const out = sanitizeBackendError('prometheus', f('backend', nasty));
    expect(out).toBe('backend_error: prometheus rejected the query (bad_data)');
    for (const bad of ['sum(', 'http', 'prom.internal', 'service_name', '1m']) expect(out).not.toContain(bad);
  });
  it('drops a machine code that is not a plain code', () => {
    expect(sanitizeBackendError('loki', f('backend', 'loki sum(rate(x)): boom'))).toBe('backend_error: loki rejected the query');
  });
  it.each([
    ['timeout', 'backend_error: loki timed out'],
    ['network', 'backend_error: loki unreachable'],
    ['http', 'backend_error: loki returned a non-JSON response'],
    ['parse', 'backend_error: loki returned an unexpected response'],
  ])('%s', (kind, expected) => expect(sanitizeBackendError('loki', f(kind, 'connect ECONNREFUSED http://10.0.0.1:3100'))).toBe(expected));
  it('every sanitized message fits Evidence.error', () => {
    for (const kind of ['timeout', 'network', 'aborted', 'http', 'parse', 'backend']) {
      expect(sanitizeBackendError('prometheus', f(kind, 'x'.repeat(5000))).length).toBeLessThanOrEqual(300);
    }
  });
  it('invalidInput is prefixed, redacted and ≤ 300 chars', () => {
    const out = invalidInput(`bad value Bearer abcdefghijklmnop ${'y'.repeat(1000)}`);
    expect(out.startsWith('invalid_input: ')).toBe(true);
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out.length).toBeLessThanOrEqual(300);
  });
});
