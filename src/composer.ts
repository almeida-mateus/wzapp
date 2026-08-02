import { Context } from "./context.js";
import {
  type FilterCore,
  type FilterQuery,
  matchFilter,
} from "./filter.js";
import { getEffectiveText } from "./helpers/message.js";
import {
  BotError,
  type MaybePromise,
  type Middleware,
  type MiddlewareFn,
  type MiddlewareObj,
  type NextFn,
} from "./types.js";

/** Converts any middleware-like value into a plain {@link MiddlewareFn}. */
function flatten<C extends Context>(mw: Middleware<C>): MiddlewareFn<C> {
  return typeof mw === "function"
    ? mw
    : (ctx, next) => mw.middleware()(ctx, next);
}

/**
 * Sequentially composes two middleware functions: when `first` calls its
 * `next`, control passes to `andThen` (which in turn receives the outer
 * `next`). Calling `next` more than once in `first` is a programmer error.
 */
function concat<C extends Context>(
  first: MiddlewareFn<C>,
  andThen: MiddlewareFn<C>,
): MiddlewareFn<C> {
  return async (ctx, next) => {
    let nextCalled = false;
    await first(ctx, async () => {
      if (nextCalled) {
        throw new Error("`next` already called before!");
      }
      nextCalled = true;
      await andThen(ctx, next);
    });
  };
}

/** A middleware that simply yields to the next layer. */
function pass<C extends Context>(_ctx: C, next: NextFn): Promise<void> {
  return next();
}

/** Terminal `next`. Resolves immediately, ending the chain. */
const leaf: NextFn = () => Promise.resolve();

/**
 * Runs a middleware function to completion against a context object, using a
 * terminal `next` that resolves immediately. Used by {@link Composer.fork} to
 * drive the forked stack independently of the main chain.
 */
export async function run<C extends Context>(
  mw: MiddlewareFn<C>,
  ctx: C,
): Promise<void> {
  await mw(ctx, leaf);
}

/**
 * Builds a matcher for `.hears`/`.command` triggers. Strings match exactly,
 * arrays are OR'd, and regular expressions are tested against the input.
 * Returns `null` when nothing matched; otherwise returns a `RegExpMatchArray`
 * so callers can stash it in `ctx.match`.
 */
function triggerFn(
  trigger: string | readonly string[] | RegExp,
): (text: string) => RegExpMatchArray | null {
  if (trigger instanceof RegExp) {
    return (text) => text.match(trigger);
  }
  const triggers = typeof trigger === "string" ? [trigger] : trigger;
  return (text) => {
    for (const t of triggers) {
      if (t === text) {
        // Synthesise a RegExpMatchArray-shaped result so the API stays
        // uniform between string and regex triggers.
        const result = [t] as unknown as RegExpMatchArray;
        result.index = 0;
        result.input = text;
        return result;
      }
    }
    return null;
  };
}

// ─── WhatsApp chat-type filter helper ───
//
// The `chatType` shortcut maps the high-level kind (`private`, `group`,
// `broadcast`) onto the JID-based predicates exposed by Context. `broadcast`
// covers `status@broadcast` and `@broadcast`-suffixed list JIDs; newsletter
// (channel) JIDs match none of the three kinds.

type ChatType = "private" | "group" | "broadcast";

function chatTypePredicate(types: ChatType | readonly ChatType[]) {
  const set = new Set<ChatType>(typeof types === "string" ? [types] : types);
  return (ctx: Context): boolean => {
    if (set.has("private") && ctx.isPrivate) return true;
    if (set.has("group") && ctx.isGroup) return true;
    if (set.has("broadcast") && ctx.isBroadcast) return true;
    return false;
  };
}

// ─── Composer ───

/**
 * Filter queries that {@link Composer.ignore} accepts. These are the ones
 * where filtering out actually changes behavior in a real bot:
 *
 * - `"message:from_me"`: skip echoes of the bot's own outgoing messages.
 *   WhatsApp's multi-device protocol mirrors them back as `messages.upsert`
 *   with `key.fromMe: true`. Without this filter, handlers like
 *   `.on("message:image", ...)` would also fire for the bot's own replies,
 *   causing duplicate work or infinite loops.
 * - `"message:broadcast"`: skip `status@broadcast` updates and broadcast
 *   list messages.
 * - `"message:forwarded"`: skip messages flagged as forwarded.
 */
export type IgnorableQuery =
  | "message:from_me"
  | "message:broadcast"
  | "message:forwarded";

/**
 * Middleware composer. The core of the bot's request pipeline: every
 * registered handler is appended to an internal chain that runs top-to-bottom
 * for each update, following the onion model (each middleware can act before
 * and after calling `next()`).
 *
 * `Bot<C>` extends `Composer<C>`, so everything documented here is also
 * available on a bot instance. The composer can also be used standalone, then
 * spliced into another via `.use(myComposer)`, because it implements
 * {@link MiddlewareObj}.
 *
 * The second type parameter `Q` tracks the set of {@link FilterQuery} strings
 * still valid for `.on` on this composer. {@link Composer.ignore} narrows
 * `Q`, so trying to register a handler for an already-ignored query becomes
 * a compile-time error.
 *
 * @example
 * // Standalone composer used as a feature module:
 * import { Composer, type Context } from "@almeidamateus/wzapp";
 *
 * export const admin = new Composer<Context>();
 * admin.command("ban", (ctx) => ctx.reply("banned"));
 * admin.command("kick", (ctx) => ctx.reply("kicked"));
 *
 * // somewhere in bot.ts:
 * bot.use(admin);
 */
export class Composer<
  C extends Context = Context,
  Q extends FilterQuery = FilterQuery,
> implements MiddlewareObj<C>
{
  private handler: MiddlewareFn<C>;

  constructor(...middleware: Array<Middleware<C>>) {
    if (middleware.length === 0) {
      this.handler = pass;
    } else {
      this.handler = middleware
        .map((m) => flatten<C>(m))
        .reduce((acc, cur) => concat(acc, cur));
    }
  }

  /**
   * Returns the composed middleware function. Implements
   * {@link MiddlewareObj}, so any composer can be passed to `.use()` of
   * another composer to splice the whole stack in place.
   */
  middleware(): MiddlewareFn<C> {
    return this.handler;
  }

  /**
   * Appends one or more middlewares to the chain. They run in registration
   * order, and each one decides whether to call `next()` (passing control to
   * the next middleware) or short-circuit.
   *
   * Returns a fresh sub-composer that controls only the appended portion of
   * the stack. Chained calls like `.use(a).command("foo", b)` attach `b`
   * exclusively to the sub-composer, not to the parent.
   *
   * @example
   * // Logging middleware:
   * bot.use(async (ctx, next) => {
   *   const start = Date.now();
   *   await next();
   *   console.log(`processed in ${Date.now() - start}ms`);
   * });
   *
   * @example
   * // Splice a feature module into the bot:
   * const auth = new Composer<Context>();
   * auth.use(requireLogin);
   * auth.command("admin", adminPanel);
   * bot.use(auth);
   */
  use(...middleware: Array<Middleware<C>>): Composer<C, Q> {
    const composer = new Composer<C, Q>(...middleware);
    this.handler = concat(this.handler, flatten(composer));
    return composer;
  }

  /**
   * Registers middleware that runs only for updates matching the supplied
   * filter query. Arrays of queries form an OR.
   *
   * The handler's `ctx.update` is narrowed by the query at compile time. For
   * example, inside `.on("message:image", h)` you can write
   * `ctx.update.message.message.imageMessage` without optional chaining: TS
   * knows the update is a message variant.
   *
   * Trying to register a query that has been removed via {@link ignore} is
   * a compile-time error.
   *
   * @example
   * // Single query:
   * bot.on("message:text", (ctx) => ctx.reply(`echo: ${ctx.text}`));
   *
   * @example
   * // OR across queries:
   * bot.on(["message:image", "message:video"], (ctx) => ctx.react("👀"));
   *
   * @example
   * // Narrowing inside the handler:
   * bot.on("message:image", (ctx) => {
   *   const width = ctx.update.message.message.imageMessage.width;
   * });
   *
   * @see {@link Composer.ignore} for removing a query from the allowed set.
   */
  on<S extends Q>(
    query: S | readonly S[],
    ...middleware: Array<Middleware<Context<FilterCore<S>> & C>>
  ): Composer<Context<FilterCore<S>> & C, Q> {
    const predicate = matchFilter(query as FilterQuery | readonly FilterQuery[]);
    // `matchFilter` returns a plain boolean predicate over `WhatsappUpdate`,
    // not a type guard, so TS gets no narrowing from calling it. We assert
    // the narrowing manually here; the query's runtime check is the
    // predicate itself.
    return this.filter(
      (ctx: C): ctx is Context<FilterCore<S>> & C => predicate(ctx.update),
      ...middleware,
    ) as Composer<Context<FilterCore<S>> & C, Q>;
  }

  /**
   * Drops updates matching one of the {@link IgnorableQuery} filter queries.
   * The returned composer is type-narrowed: registering a handler for the
   * ignored query becomes a compile-time error, because that handler could
   * never fire.
   *
   * For arbitrary predicates, use {@link drop} instead. It accepts any
   * function but does not type-narrow.
   *
   * @example
   * // Standard echo-protection idiom:
   * const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");
   * bot.on("message:image", echo);     // fires only on incoming images
   * bot.on("message:from_me", h);      // ❌ compile error: already ignored
   *
   * @example
   * // Listen to own messages, then filter:
   * const bot = new Bot({ authPath: "./auth" });
   * bot.on("message:from_me", auditLog);   // sees own messages
   * bot.ignore("message:from_me");          // from here on, fromMe is filtered
   * bot.command("start", ...);
   *
   * @example
   * // Multiple at once:
   * bot.ignore(["message:from_me", "message:broadcast"]);
   *
   * @see {@link IgnorableQuery} for the list of accepted queries.
   * @see {@link drop} for arbitrary predicates without type narrowing.
   */
  ignore<S extends IgnorableQuery & Q>(
    query: S | readonly S[],
  ): Composer<C, Exclude<Q, S>> {
    const predicate = matchFilter(query as FilterQuery | readonly FilterQuery[]);
    this.use((ctx, next) => (predicate(ctx.update) ? Promise.resolve() : next()));
    return this as unknown as Composer<C, Exclude<Q, S>>;
  }

  /**
   * Reacts to a slash command at the start of the effective text
   * (`ctx.text` for plain messages or `ctx.caption` for media). The prefix is
   * `'/'` by default; configure it via `BotOptions.prefix`.
   *
   * Behavior:
   *
   * - String `name`: matches `/name` exactly or `/name <args>`. The args (the
   *   text after the first space) are stored in `ctx.match`. With no args,
   *   `ctx.match` is the empty string.
   * - Array of strings: any of them match (OR).
   * - `RegExp` `name`: the regex is tested against the text after the prefix,
   *   and `ctx.match` is set to the resulting `RegExpMatchArray`.
   *
   * Only fires on `'message'` updates.
   *
   * @example
   * // Plain command:
   * bot.command("start", (ctx) => ctx.reply("hello!"));
   *
   * @example
   * // Aliases:
   * bot.command(["help", "h", "?"], (ctx) => ctx.reply("commands: ..."));
   *
   * @example
   * // Arguments:
   * bot.command("echo", (ctx) => {
   *   const args = typeof ctx.match === "string" ? ctx.match : "";
   *   ctx.reply(args || "(nothing to echo)");
   * });
   *
   * @example
   * // RegExp with capture groups:
   * bot.command(/^cep\s*(\d{8})$/, (ctx) => {
   *   const cep = (ctx.match as RegExpMatchArray)[1];
   *   ctx.reply(`looking up ${cep}…`);
   * });
   *
   * @example
   * // Custom prefix:
   * const bot = new Bot({ authPath: "./auth", prefix: "!" });
   * bot.command("ping", (ctx) => ctx.reply("pong"));  // matches "!ping"
   */
  command(
    name: string | readonly string[] | RegExp,
    ...middleware: Array<Middleware<C>>
  ): Composer<C, Q> {
    // Always restrict to message updates first. Commands live in text.
    // Discriminate `ctx.update` via its tag so TypeScript can narrow to the
    // `message` variant inside the predicate body.
    return this.filter((ctx) => {
      if (ctx.update.type !== "message") return false;
      const text = getEffectiveText(ctx.update.message);
      if (!text) return false;
      const prefix = (ctx as Context & { prefix?: string }).prefix ?? "/";
      if (!text.startsWith(prefix)) return false;
      const after = text.slice(prefix.length);
      if (after.length === 0) return false;

      if (name instanceof RegExp) {
        const m = after.match(name);
        if (!m) return false;
        (ctx as Context & { match?: RegExpMatchArray | string }).match = m;
        return true;
      }

      const names = typeof name === "string" ? [name] : name;
      // Match either `/name` exactly or `/name <args...>`.
      for (const n of names) {
        if (after === n) {
          (ctx as Context & { match?: RegExpMatchArray | string }).match = "";
          return true;
        }
        if (after.startsWith(n + " ")) {
          (ctx as Context & { match?: RegExpMatchArray | string }).match =
            after.slice(n.length + 1);
          return true;
        }
      }
      return false;
    }, ...middleware);
  }

  /**
   * Matches the message's effective text against a trigger. Behaves like
   * {@link command} but without the prefix or args split: the full text is
   * matched as-is.
   *
   * Behavior:
   *
   * - String trigger: exact equality with the text.
   * - Array of strings: any equals (OR).
   * - `RegExp`: regex `.match()` against the text. The full
   *   `RegExpMatchArray` is stored in `ctx.match`, so capture groups are
   *   available.
   *
   * Only fires on `'message'` updates.
   *
   * @example
   * // Exact match:
   * bot.hears("hi", (ctx) => ctx.reply("hello!"));
   *
   * @example
   * // Regex with capture groups:
   * bot.hears(/^my name is (.+)$/i, (ctx) => {
   *   const name = (ctx.match as RegExpMatchArray)[1];
   *   ctx.reply(`nice to meet you, ${name}`);
   * });
   *
   * @example
   * // Array of alternatives:
   * bot.hears(["yes", "yeah", "yep"], (ctx) => ctx.reply("agreed"));
   */
  hears(
    trigger: string | readonly string[] | RegExp,
    ...middleware: Array<Middleware<C>>
  ): Composer<C, Q> {
    const test = triggerFn(trigger);
    return this.filter((ctx) => {
      if (ctx.update.type !== "message") return false;
      const text = getEffectiveText(ctx.update.message);
      if (!text) return false;
      const m = test(text);
      if (!m) return false;
      (ctx as Context & { match?: RegExpMatchArray | string }).match =
        trigger instanceof RegExp ? m : m[0] ?? "";
      return true;
    }, ...middleware);
  }

  /**
   * Restricts middleware to one or more chat kinds. The classification is
   * derived from the JID of `ctx.chat`:
   *
   * - `'private'`: JID ends in `@s.whatsapp.net` or `@lid` (one-on-one DMs).
   * - `'group'`: JID ends in `@g.us`.
   * - `'broadcast'`: JID is `status@broadcast` or ends in `@broadcast`.
   *
   * @example
   * bot.chatType("group", (ctx) => ctx.reply("hello, group!"));
   *
   * @example
   * bot.chatType(["private", "group"], (ctx) => ctx.reply("not a status"));
   */
  chatType<T extends ChatType>(
    types: T | readonly T[],
    ...middleware: Array<Middleware<C>>
  ): Composer<C, Q> {
    return this.filter(chatTypePredicate(types), ...middleware);
  }

  /**
   * Restricts middleware to updates whose sender JID matches one of the
   * given JIDs. The match is exact. For DMs, `ctx.from` equals the chat JID;
   * in groups, it equals the participant JID. Updates that are not messages
   * have `ctx.from === ""`, so they never match.
   *
   * Useful for owner-only commands and allowlists.
   *
   * @example
   * const OWNER = "5511999999999@s.whatsapp.net";
   * bot.from(OWNER).command("shutdown", () => process.exit(0));
   *
   * @example
   * const TEAM = ["a@s.whatsapp.net", "b@s.whatsapp.net"];
   * bot.from(TEAM, (ctx, next) => {
   *   ctx.reply("team member detected");
   *   return next();
   * });
   */
  from(jid: string | readonly string[], ...middleware: Array<Middleware<C>>): Composer<C, Q> {
    const set = new Set<string>(typeof jid === "string" ? [jid] : jid);
    return this.filter((ctx) => set.has(ctx.from), ...middleware);
  }

  /**
   * Guards a sub-stack with a predicate. Comes in two forms:
   *
   * 1. **Boolean predicate**: middleware runs when the predicate returns a
   *    truthy value. The predicate may be async.
   * 2. **Type-guard predicate** (`ctx is D`): also narrows the context type
   *    for the downstream middleware, so the handler sees a more specific
   *    `ctx`.
   *
   * @example
   * // Boolean predicate:
   * bot.filter((ctx) => ctx.isGroup, async (ctx) => {
   *   await ctx.reply("groups only");
   * });
   *
   * @example
   * // Type-guard, narrows ctx for the handler:
   * function hasText(ctx: Context): ctx is Context & { text: string } {
   *   return typeof ctx.text === "string" && ctx.text.length > 0;
   * }
   * bot.filter(hasText, (ctx) => {
   *   ctx.reply(ctx.text.toUpperCase());  // ctx.text is string, not optional
   * });
   *
   * @see {@link drop} for the inverse.
   */
  filter<D extends C>(
    predicate: (ctx: C) => ctx is D,
    ...middleware: Array<Middleware<D>>
  ): Composer<D, Q>;
  filter(
    predicate: (ctx: C) => MaybePromise<boolean>,
    ...middleware: Array<Middleware<C>>
  ): Composer<C, Q>;
  filter<D extends C>(
    predicate: (ctx: C) => MaybePromise<boolean>,
    ...middleware: Array<Middleware<D>>
  ): Composer<D, Q> {
    const composer = new Composer<D, Q>(...middleware);
    this.branch(
      predicate,
      composer as unknown as Middleware<C>,
      pass as MiddlewareFn<C>,
    );
    return composer;
  }

  /**
   * Inverse of {@link filter}. Middleware runs only when the predicate is
   * falsy. Useful as an early-exit short circuit before any downstream
   * handler.
   *
   * @example
   * // Block a JID from reaching any handler below:
   * bot.drop((ctx) => ctx.from === "spam@s.whatsapp.net");
   *
   * @example
   * // Skip command-style messages from a sub-handler:
   * const conversational = bot.use(async (ctx, next) => await next());
   * conversational.drop((ctx) => ctx.text?.startsWith("/") ?? false);
   *
   * @see {@link ignore} for a typed shortcut for the common case of dropping
   * `message:from_me`.
   */
  drop(
    predicate: (ctx: C) => MaybePromise<boolean>,
    ...middleware: Array<Middleware<C>>
  ): Composer<C, Q> {
    return this.filter(
      async (ctx) => !(await predicate(ctx)),
      ...middleware,
    );
  }

  /**
   * Two-way conditional split. Runs `trueMw` when the predicate returns
   * truthy, otherwise `falseMw`. Both branches share the same downstream
   * `next`.
   *
   * Useful when the same update needs distinct handling on two paths, and
   * you want both paths visible at the registration site.
   *
   * @example
   * bot.branch(
   *   (ctx) => ctx.isGroup,
   *   (ctx) => ctx.reply("hello, group"),
   *   (ctx) => ctx.reply("hello in private"),
   * );
   */
  branch(
    predicate: (ctx: C) => MaybePromise<boolean>,
    trueMw: Middleware<C> | Array<Middleware<C>>,
    falseMw: Middleware<C> | Array<Middleware<C>>,
  ): Composer<C, Q> {
    return this.lazy(async (ctx) => ((await predicate(ctx)) ? trueMw : falseMw));
  }

  /**
   * Runs middleware in a parallel "fork" that does NOT block the rest of the
   * pipeline. The downstream `next()` is awaited concurrently with the fork.
   *
   * The fork's promise is part of the outer `Promise.all`, so errors thrown
   * inside still propagate to the bot's error handler. Useful for analytics,
   * remote logging, or any side effect where you don't want the user-facing
   * response to wait.
   *
   * @example
   * bot.fork(async (ctx) => {
   *   await analytics.track("message_received", { from: ctx.from });
   * });
   *
   * bot.command("start", (ctx) => ctx.reply("hi"));
   * // The reply is not delayed by the analytics call.
   */
  fork(...middleware: Array<Middleware<C>>): Composer<C, Q> {
    const composer = new Composer<C, Q>(...middleware);
    const forked = flatten(composer);
    this.use((ctx, next) => Promise.all([next(), run(forked, ctx)]));
    return composer;
  }

  /**
   * Builds middleware on demand, once per context. Useful when the handler
   * depends on async state (per-chat configuration, feature flags) that you
   * don't want to load at registration time.
   *
   * The factory can return a single middleware or an array. The result is
   * composed and run as if it had been registered with {@link use}.
   *
   * @example
   * bot.lazy(async (ctx) => {
   *   const config = await loadConfig(ctx.chat);
   *   return config.enabled ? mainHandler : skipHandler;
   * });
   */
  lazy(
    factory: (
      ctx: C,
    ) => MaybePromise<Middleware<C> | Array<Middleware<C>>>,
  ): Composer<C, Q> {
    return this.use(async (ctx, next) => {
      const produced = await factory(ctx);
      const arr: Array<Middleware<C>> = Array.isArray(produced)
        ? produced
        : [produced];
      await flatten(new Composer<C, Q>(...arr))(ctx, next);
    });
  }

  /**
   * Dispatches to one of several named middleware stacks based on the value
   * returned by `router`. If `router` returns `undefined`, or a key that
   * isn't in `routes`, the optional `fallback` runs instead. Defaults to
   * `pass` (continue down the chain).
   *
   * The dynamic equivalent of a switch over command names.
   *
   * @example
   * bot.route(
   *   (ctx) => ctx.text?.split(" ")[0],
   *   {
   *     "/help": helpHandler,
   *     "/about": aboutHandler,
   *     "/stats": statsHandler,
   *   },
   *   defaultHandler,
   * );
   */
  route<R extends PropertyKey>(
    router: (ctx: C) => MaybePromise<R | undefined>,
    routes: Record<R, Middleware<C>>,
    fallback: Middleware<C> = pass,
  ): Composer<C, Q> {
    return this.lazy(async (ctx) => {
      const key = await router(ctx);
      if (key === undefined) return fallback;
      const handler = routes[key];
      return handler ?? fallback;
    });
  }

  /**
   * Wraps the supplied middleware in an error boundary. Synchronous and
   * asynchronous errors thrown inside the bound stack are wrapped in a
   * {@link BotError} and forwarded to `handler`. The bot's global `.catch()`
   * is bypassed for errors that the boundary handler swallows.
   *
   * If the boundary `handler` itself calls `next()`, control resumes after
   * the boundary, allowing recovery without dropping the update.
   *
   * @example
   * bot.errorBoundary(
   *   (err, next) => {
   *     console.error("parser failed:", err);
   *     return next();  // continue past the boundary
   *   },
   *   parseUserMessage,
   *   handleParsedMessage,
   * );
   *
   * @example
   * // Boundary that does NOT continue (errors swallowed):
   * bot.errorBoundary(
   *   (err) => console.error("non-critical:", err),
   *   nonCriticalHandler,
   * );
   */
  errorBoundary(
    handler: (err: BotError<C>, next: NextFn) => MaybePromise<unknown>,
    ...middleware: Array<Middleware<C>>
  ): Composer<C, Q> {
    const composer = new Composer<C, Q>(...middleware);
    const bound = flatten(composer);
    this.use(async (ctx, next) => {
      let nextCalled = false;
      const cont: NextFn = () => {
        nextCalled = true;
        return Promise.resolve();
      };
      try {
        await bound(ctx, cont);
      } catch (err) {
        nextCalled = false;
        await handler(new BotError<C>(err, ctx), cont);
      }
      if (nextCalled) await next();
    });
    return composer;
  }
}
