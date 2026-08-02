/** Constructor options for {@link Runner}. */
export interface RunnerOptions {
  /**
   * Maximum number of `handle` invocations in flight at the same time.
   * Must be a finite number `>= 1`. Non-integer values are floored.
   *
   * Higher values reduce queue buildup on busy bots at the cost of more
   * open sockets, file handles, and memory.
   */
  concurrency: number;
}

/**
 * Concurrent update queue. Generic over the payload `U` so the runner has no
 * knowledge of WhatsApp specifics; the {@link Bot} wires it to
 * `WhatsappUpdate`.
 *
 * Semantics mirror `@grammyjs/runner`:
 *
 * - `push(u)` enqueues and returns immediately. Up to `concurrency` workers
 *   consume from the queue in parallel.
 * - Ordering across the queue is NOT preserved. Two messages enqueued back
 *   to back may be processed out of order if their handlers have different
 *   durations.
 * - Per-update errors thrown by `handle` are caught internally so the
 *   runner stays alive. Set a global error handler via `bot.catch(...)` if
 *   you need visibility.
 * - `drain()` resolves once the queue is empty AND all in-flight workers
 *   have finished. `stop()` prevents new pushes but does not cancel work in
 *   flight; combine with `drain()` for graceful shutdown.
 *
 * Used internally by `Bot.start`. Most users never construct one directly.
 *
 * @example
 * // Standalone use (e.g., for an external integration):
 * const runner = new Runner<MyUpdate>(
 *   async (u) => { await processUpdate(u); },
 *   { concurrency: 8 },
 * );
 * runner.push(someUpdate);
 * await runner.drain();
 */
export class Runner<U> {
  private readonly handle: (u: U) => Promise<void>;
  private readonly concurrency: number;
  private readonly queue: U[] = [];
  private active = 0;
  private idleWaiters: Array<() => void> = [];
  private stopped = false;

  constructor(handle: (u: U) => Promise<void>, opts: RunnerOptions) {
    if (!Number.isFinite(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`Runner concurrency must be >= 1 (got ${opts.concurrency})`);
    }
    this.handle = handle;
    this.concurrency = Math.floor(opts.concurrency);
  }

  /**
   * Enqueue an update for processing. Returns immediately without waiting
   * for the handler. No-op after {@link stop}.
   */
  push(u: U): void {
    if (this.stopped) return;
    this.queue.push(u);
    this.pump();
  }

  /**
   * Returns a `Promise` that resolves when the queue is empty AND no workers
   * are running. If the runner is already idle, resolves immediately on the
   * next microtask.
   *
   * Multiple concurrent callers each get their own promise; they all
   * resolve at the same moment.
   *
   * @example
   * // Graceful shutdown pattern:
   * runner.stop();          // refuse new pushes
   * await runner.drain();   // wait for handlers in flight
   */
  drain(): Promise<void> {
    if (this.queue.length === 0 && this.active === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /**
   * Stop accepting new updates. Updates already in the queue and in flight
   * still complete; call {@link drain} after to await them.
   *
   * Idempotent: calling again after stopping is a no-op.
   */
  stop(): void {
    this.stopped = true;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift() as U;
      this.active++;
      // Fire-and-forget. `handle` is expected to swallow its own errors;
      // we still guard with .catch() to keep the runner alive on bugs.
      this.handle(next)
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          if (this.queue.length > 0) {
            this.pump();
          } else if (this.active === 0) {
            this.flushIdleWaiters();
          }
        });
    }
  }

  private flushIdleWaiters(): void {
    if (this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
