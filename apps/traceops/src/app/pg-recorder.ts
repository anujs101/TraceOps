/**
 * CallRecorder that persists every LLM attempt as one llm_calls row (persistence.md §1a,
 * via PgInvestigationStore.insertLlmCall → toLlmCallRow()).
 *
 * CallRecorder.record() is synchronous, so inserts are queued in order and awaited by flush().
 * A failed insert is logged (message redacted) and never thrown into the tool loop: losing a
 * bookkeeping row must not fail an investigation that already spent its tokens.
 */
import { redactSecrets } from '../llm/errors.ts';
import type { CallRecorder, LlmCallRecord } from '../llm/index.ts';

export type LlmCallSink = { insertLlmCall(rec: LlmCallRecord): Promise<unknown> };
export type RecorderLog = (msg: string, fields?: Record<string, unknown>) => void;

export class PgCallRecorder implements CallRecorder {
  private tail: Promise<void> = Promise.resolve();
  private failures = 0;

  constructor(private readonly sink: LlmCallSink, private readonly log: RecorderLog = (m, f) => console.error(`[llm_calls] ${m}`, f ?? '')) {}

  record(r: LlmCallRecord): void {
    this.tail = this.tail.then(() => this.sink.insertLlmCall(r)).then(
      () => undefined,
      (e: unknown) => {
        this.failures++;
        this.log('insert failed', { turn: r.turn, attempt: r.attempt, error: redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, 200) });
      });
  }

  /** Wait until every recorded attempt has been written (or has failed and been logged). */
  async flush(): Promise<{ failures: number }> {
    await this.tail;
    return { failures: this.failures };
  }
}
