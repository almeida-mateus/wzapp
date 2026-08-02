import type { Context } from "./context.js";

/**
 * The "continue down the chain" function passed to every middleware as the
 * second argument. Calling it yields control to the next middleware. If you
 * skip the call, the chain stops (the middleware is the terminal handler).
 *
 * Calling `next()` more than once within a single middleware is a programmer
 * error. It throws when downstream middleware is registered (the composer's
 * chaining guard); at the very end of the chain, the terminal `next` and
 * error-boundary continuations accept repeated calls silently.
 *
 * @example
 * bot.use(async (ctx, next) => {
 *   const start = Date.now();
 *   await next();  // yield to downstream
 *   console.log(`took ${Date.now() - start}ms`);
 * });
 */
export type NextFn = () => Promise<void>;

/**
 * Convenience alias for "either a `T` or a `Promise<T>`". Used pervasively in
 * middleware signatures so handlers can be sync or async.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A middleware function. Receives the {@link Context} for the current update
 * and a {@link NextFn} for yielding to downstream middleware.
 *
 * The return value is ignored. Sync and async forms are both accepted.
 *
 * @example
 * const myMw: MiddlewareFn = async (ctx, next) => {
 *   console.log("before");
 *   await next();
 *   console.log("after");
 * };
 *
 * bot.use(myMw);
 */
export type MiddlewareFn<C extends Context = Context> = (
  ctx: C,
  next: NextFn,
) => MaybePromise<unknown>;

/**
 * An object that exposes a `.middleware()` accessor returning a
 * {@link MiddlewareFn}. {@link Composer} implements this, which is why you
 * can pass one composer to another composer's `.use()` to splice the entire
 * sub-stack in place.
 */
export interface MiddlewareObj<C extends Context = Context> {
  middleware(): MiddlewareFn<C>;
}

/**
 * Either a plain {@link MiddlewareFn} or any object exposing one via
 * {@link MiddlewareObj}. Every method that accepts middleware accepts this
 * broader union.
 */
export type Middleware<C extends Context = Context> =
  | MiddlewareFn<C>
  | MiddlewareObj<C>;

/**
 * Signature for the global error handler set via `bot.catch(...)`. Receives
 * a {@link BotError} that wraps the original error plus the `ctx` that was
 * being processed when it was thrown.
 *
 * @example
 * bot.catch((err) => {
 *   console.error("bot error on", err.ctx.update.type, ":", err.error);
 * });
 */
export type ErrorHandler<C extends Context = Context> = (
  error: BotError<C>,
) => MaybePromise<unknown>;

/**
 * Wraps any error thrown inside the middleware pipeline together with the
 * {@link Context} that was being processed. Forwarded to the global error
 * handler set via `bot.catch(...)` and to {@link Composer.errorBoundary}
 * boundaries.
 *
 * The original (unwrapped) error is accessible at `error`. The message and
 * stack are copied from it when possible, so logging `bot error: <err>`
 * preserves useful diagnostics.
 *
 * @example
 * bot.catch((err) => {
 *   if (err.error instanceof MyDbError) {
 *     // ...
 *   }
 *   console.error(err);  // includes the original stack
 * });
 */
export class BotError<C extends Context = Context> extends Error {
  /** The original error that was thrown. */
  public readonly error: unknown;
  /** The context that was being processed when the error occurred. */
  public readonly ctx: C;

  constructor(error: unknown, ctx: C) {
    super(toMessage(error));
    this.name = "BotError";
    this.error = error;
    this.ctx = ctx;
    if (error instanceof Error && error.stack) {
      this.stack = `${this.name}: ${this.message}\n${error.stack}`;
    }
  }
}

/** Best-effort conversion of an unknown error to a string for `.message`. */
function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
