/**
 * Pins the InvestigationOutcome.error format shared by the investigator (describeError writes it)
 * and the job handler (parseOutcomeError reads it to decide retries, persistence.md §2).
 */
import { describe, expect, it } from 'vitest';
import { LLM_ERROR_KINDS } from '@traceops/contracts';
import { LlmError } from '../../src/llm/index.ts';
import { describeError, parseOutcomeError } from '../../src/investigator/investigate.ts';

describe('outcome error format', () => {
  it.each(LLM_ERROR_KINDS)('round-trips the LLM error kind %s', (kind) => {
    const s = describeError(new LlmError(kind, 'upstream said no'));
    expect(s).toBe(`llm_${kind}: upstream said no`);
    expect(parseOutcomeError(s)).toEqual({ llmKind: kind, message: 'upstream said no' });
  });

  it('non-LLM errors have no kind and keep their (redacted, capped) message', () => {
    const s = describeError(new Error(`connection terminated, key gsk_ABCDEFGHijklmnop12345678 ${'x'.repeat(400)}`));
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).not.toContain('gsk_ABCDEFGH');
    expect(parseOutcomeError(s)).toEqual({ llmKind: null, message: s });
    expect(parseOutcomeError(describeError('plain string'))).toEqual({ llmKind: null, message: 'plain string' });
  });

  it('an unknown llm_ prefix is not mistaken for a kind; null stays null', () => {
    expect(parseOutcomeError('llm_nonsense: x')).toEqual({ llmKind: null, message: 'llm_nonsense: x' });
    expect(parseOutcomeError(null)).toBeNull();
  });

  it('multi-line messages survive the round trip', () => {
    expect(parseOutcomeError(describeError(new LlmError('server', 'line1\nline2')))).toEqual({ llmKind: 'server', message: 'line1\nline2' });
  });
});
