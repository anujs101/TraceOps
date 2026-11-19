import type pg from 'pg';
import { claimJob, completeJob, failJob, heartbeat, markDead, type Job } from './queue.ts';

export type JobHandler = (job: Job) => Promise<void>;
export type WorkerLog = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export type WorkerOptions = {
  pool: pg.Pool;
  /**
   * Injected by the main session (D's investigator). Resolving = the job is done, including a
   * completed investigation whose report failed validation or had insufficient evidence
   * (never retried). Throwing = infrastructure failure: retried until max_attempts, then dead.
   */
  handler: JobHandler;
  pollMs?: number; // idle poll, 1 s (persistence.md §2)
  heartbeatMs?: number; // lease extension, 30 s (persistence.md §2)
  retryBaseMs?: number; // backoff base for completion bookkeeping (3 tries: base, 4×base)
  log?: WorkerLog;
};

export type RunResult = 'idle' | 'done' | 'requeued' | 'dead' | 'lease_exhausted';

export class Worker {
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly retryBaseMs: number;
  private readonly log: WorkerLog;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly o: WorkerOptions) {
    this.pollMs = o.pollMs ?? 1000;
    this.heartbeatMs = o.heartbeatMs ?? 30_000;
    this.retryBaseMs = o.retryBaseMs ?? 200;
    this.log = o.log ?? ((level, msg, f) => console[level === 'info' ? 'log' : level](`[worker] ${msg}`, f ?? ''));
  }

  /** Claim and run at most one job. */
  async runOnce(): Promise<RunResult> {
    const job = await claimJob(this.o.pool);
    if (!job) return 'idle';

    // The claim query is verbatim and cannot see max_attempts for a reclaimed (expired-lease) job:
    // a job claimed beyond max_attempts is dead, and its handler is not run again.
    if (job.attempts > job.max_attempts) {
      await markDead(this.o.pool, job.id, job.attempts, `lease expired after ${job.max_attempts} attempts`);
      this.log('warn', 'job dead (attempts exhausted)', { job: job.id, attempts: job.attempts });
      return 'lease_exhausted';
    }

    const beat = setInterval(() => {
      heartbeat(this.o.pool, job.id, job.attempts)
        .then((ok) => { if (!ok) this.log('warn', 'heartbeat: lease lost', { job: job.id }); })
        .catch((e) => this.log('error', 'heartbeat failed', { job: job.id, error: msg(e) }));
    }, this.heartbeatMs);
    try {
      await this.o.handler(job);
    } catch (e) {
      clearInterval(beat);
      // a throw here must not escape: the job would sit `running` until its lease expires
      const to = await this.bookkeeping(job.id, 'failJob', () => failJob(this.o.pool, job.id, job.attempts, msg(e)));
      this.log('warn', `job failed → ${to}`, { job: job.id, attempts: job.attempts, error: msg(e) });
      return to === 'dead' ? 'dead' : 'requeued';
    }
    clearInterval(beat);
    // The handler SUCCEEDED (and spent its tokens). Do not let a transient DB error here turn into a re-run.
    const done = await this.bookkeeping(job.id, 'completeJob', () => completeJob(this.o.pool, job.id, job.attempts));
    if (done === false) this.log('warn', 'job finished but its claim was lost (lease expired or reclaimed)', { job: job.id });
    return 'done';
  }

  /** Up to 3 tries with backoff; then log loudly and give up (never throws). Returns undefined when it gave up. */
  private async bookkeeping<T>(jobId: string, what: string, fn: () => Promise<T>): Promise<T | undefined> {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= 3) {
          this.log('error', `${what} failed ${i}× — job stays running until its lease expires, then it will be RE-RUN (extra LLM spend)`, { job: jobId, error: msg(e) });
          return undefined;
        }
        this.log('warn', `${what} failed (try ${i}/3), retrying`, { job: jobId, error: msg(e) });
        await new Promise((r) => setTimeout(r, this.retryBaseMs * 4 ** (i - 1)));
      }
    }
  }

  /** Poll loop: drain while there is work, otherwise wait `pollMs`. Never throws. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        let r: RunResult = 'idle';
        try { r = await this.runOnce(); } catch (e) { this.log('error', 'worker iteration failed', { error: msg(e) }); }
        if (r === 'idle' && !this.stopped) await this.sleep();
      }
    })();
  }

  /** Stops claiming; waits for the job in flight to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, this.pollMs);
      const self = this;
      function done() { clearTimeout(t); self.wake = null; resolve(); }
      this.wake = done;
    });
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
