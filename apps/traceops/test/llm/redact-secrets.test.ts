import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/llm/errors.ts';

describe('redactSecrets', () => {
  it.each([
    ['Groq key', 'key gsk_ABCDEFGHijklmnop12345678 rejected', 'gsk_ABCDEFGH'],
    ['OpenAI-style key (DeepSeek, v1.2)', 'Authentication Fails, Your api key: sk-0123456789abcdef0123 is invalid', 'sk-0123456789abcdef'],
    ['Anthropic key', 'sk-ant-api03-ABCDEFGHIJ', 'ABCDEFGHIJ'],
    ['bearer token', 'Bearer abcdefgh12345678', 'abcdefgh12345678'],
    ['bearer token in an Authorization header', 'Authorization: Bearer abcdefgh12345678', 'abcdefgh12345678'],
    ['account id', 'Rate limit reached in organization `org_01abcdefxyz` service tier', 'org_01abcdefxyz'],
  ])('removes a %s', (_n, text, secret) => {
    expect(redactSecrets(text)).not.toContain(secret);
  });
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('task-runner timeout after 30 s; sk-short')).toBe('task-runner timeout after 30 s; sk-short');
  });
});
