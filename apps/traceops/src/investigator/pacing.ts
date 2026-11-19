/**
 * Provider-neutral request pacing against a tokens-per-minute budget.
 *
 * Config is keyed by LlmProvider.name. A provider without an entry (or with
 * null) is not paced. Values are investigator config, not a contract; making
 * them env-configurable would add a variable to environment.md §4 (proposal first).
 *
 * Accounting: before a request we reserve `estimated input + maxOutputTokens`
 * (some providers, e.g. Groq, count the output cap at admission); after it we
 * keep the provider-reported total (or the reservation if usage is missing).
 * A request waits until the trailing-60 s total plus its reservation fits the
 * budget. A request larger than the whole budget is sent once the window is empty.
 */
import type { ChatRequest, ChatResult, LlmProvider, StructuredRequest, StructuredResult } from '../llm/index.ts';

export type PacingConfig = { tokensPerMinute: number } | null;

/** Groq on-demand tier observed at 8000 TPM (live run 2026-11-19); 7500 leaves headroom. DeepSeek: off. */
export const PROVIDER_PACING: Readonly<Record<string, PacingConfig>> = {
  groq: { tokensPerMinute: 7500 },
  deepseek: null,
};

export function pacingFor(providerName: string, table: Readonly<Record<string, PacingConfig>> = PROVIDER_PACING): PacingConfig {
  return table[providerName] ?? null;
}

/** Rough token estimate (~4 chars/token) of what a request sends: messages + schema/tools. */
export function estimateInputTokens(req: { messages: Array<{ content?: string | null }>; schema?: unknown; tools?: unknown }): number {
  const chars = req.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0) + JSON.stringify(req.schema ?? req.tools ?? '').length;
  return Math.ceil(chars / 4);
}

const WINDOW_MS = 60_000;

export type PaceEvent = { reserved: number; waitedMs: number; windowTokens: number };

export class TokenPacer {
  private used: Array<{ at: number; tokens: number }> = [];
  constructor(
    private readonly tokensPerMinute: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly onWait?: (e: PaceEvent) => void,
  ) {}

  windowTokens(): number {
    const cutoff = this.now() - WINDOW_MS;
    this.used = this.used.filter((u) => u.at > cutoff);
    return this.used.reduce((n, u) => n + u.tokens, 0);
  }

  /** Waits until `reserved` fits; returns ms waited. `afterWait` runs after each wait (e.g. cancel check). */
  async acquire(reserved: number, afterWait?: () => Promise<void>): Promise<number> {
    let waited = 0;
    for (;;) {
      const inWindow = this.windowTokens();
      if (inWindow + reserved <= this.tokensPerMinute || this.used.length === 0) {
        if (waited) this.onWait?.({ reserved, waitedMs: waited, windowTokens: inWindow });
        return waited;
      }
      // wait until enough of the oldest usage leaves the window
      let freed = 0, until = this.now();
      for (const u of this.used) {
        freed += u.tokens; until = u.at + WINDOW_MS;
        if (inWindow - freed + reserved <= this.tokensPerMinute) break;
      }
      const ms = Math.max(1, until - this.now() + 1);
      await this.sleep(ms);
      waited += ms;
      await afterWait?.();
    }
  }

  record(tokens: number) { this.used.push({ at: this.now(), tokens }); }
}

/** Decorator: paces every chat/structured request through a TokenPacer. */
export class PacedProvider implements LlmProvider {
  constructor(private readonly inner: LlmProvider, private readonly pacer: TokenPacer, private readonly afterWait?: () => Promise<void>) {}
  get name() { return this.inner.name; }
  get model() { return this.inner.model; }

  chat(req: ChatRequest): Promise<ChatResult> { return this.paced(req, () => this.inner.chat(req)); }
  structured(req: StructuredRequest): Promise<StructuredResult> { return this.paced(req, () => this.inner.structured(req)); }

  private async paced<T extends { meta: { usage: { totalTokens: number } | null } }>(req: ChatRequest | StructuredRequest, fn: () => Promise<T>): Promise<T> {
    const reserved = estimateInputTokens(req) + req.maxOutputTokens;
    await this.pacer.acquire(reserved, this.afterWait);
    const res = await fn(); // a rejected request (e.g. 429) consumed nothing: not recorded
    this.pacer.record(res.meta.usage?.totalTokens ?? reserved);
    return res;
  }
}
