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
  log?: WorkerLog;
};

export type RunResult = 'idle' | 'done' | 'requeued' | 'dead' | 'lease_exhausted';

export class Worker {
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly log: WorkerLog;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly o: WorkerOptions) {
    this.pollMs = o.pollMs ?? 1000;
    this.heartbeatMs = o.heartbeatMs ?? 30_000;
    this.log = o.log ?? ((level, msg, f) => console[level === 'info' ? 'log' : level](`[worker] ${msg}`, f ?? ''));
  }

  /** Claim and run at most one job. */
  async runOnce(): Promise<RunResult> {
    const job = await claimJob(this.o.pool);
    if (!job) return 'idle';

    // The claim query is verbatim and cannot see max_attempts for a reclaimed (expired-lease) job:
    // a job claimed beyond max_attempts is dead, and its handler is not run again.
    if (job.attempts > job.max_attempts) {
      await markDead(this.o.pool, job.id, `lease expired after ${job.max_attempts} attempts`);
      this.log('warn', 'job dead (attempts exhausted)', { job: job.id, attempts: job.attempts });
      return 'lease_exhausted';
    }

    const beat = setInterval(() => {
      heartbeat(this.o.pool, job.id)
        .then((ok) => { if (!ok) this.log('warn', 'heartbeat: lease lost', { job: job.id }); })
        .catch((e) => this.log('error', 'heartbeat failed', { job: job.id, error: msg(e) }));
    }, this.heartbeatMs);
    try {
      await this.o.handler(job);
    } catch (e) {
      clearInterval(beat);
      const to = await failJob(this.o.pool, job.id, msg(e));
      this.log('warn', `job failed → ${to}`, { job: job.id, attempts: job.attempts, error: msg(e) });
      return to === 'dead' ? 'dead' : 'requeued';
    }
    clearInterval(beat);
    if (!(await completeJob(this.o.pool, job.id))) this.log('warn', 'job finished but was no longer running (lease lost)', { job: job.id });
    return 'done';
  }

  /** Poll loop: drain while there is work, otherwise wait `pollMs`. Never throws. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = (async () => {
      while (!this.stopped) {
        let r: RunResult = 'idle';
        try { r = await this.runOnce(); } catch (e) { this.log('error', 'worker iteration failed', { error: msg(e) }); }
        if (r === 'idle') await this.sleep();
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
