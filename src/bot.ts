import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
  type AuthenticationState,
  type BaileysEventMap,
  type ConnectionState,
  type SocketConfig,
  type WASocket,
  type WAVersion,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino, { type Logger } from "pino";

import { Api } from "./api.js";
import { Composer, type IgnorableQuery } from "./composer.js";
import { Context } from "./context.js";
import type { FilterQuery } from "./filter.js";
import { Runner } from "./runner.js";
import {
  type WhatsappUpdate,
  fromBlocklistUpdate,
  fromCall,
  fromChatsDelete,
  fromChatsUpdate,
  fromChatsUpsert,
  fromConnectionUpdate,
  fromContactsUpdate,
  fromContactsUpsert,
  fromGroupParticipantsUpdate,
  fromGroupsUpdate,
  fromGroupsUpsert,
  fromMessageReceipt,
  fromMessagesDelete,
  fromMessagesReaction,
  fromMessagesUpdate,
  fromMessagesUpsert,
  fromPresenceUpdate,
} from "./update.js";
import { BotError, type ErrorHandler, type MaybePromise } from "./types.js";

/**
 * A pre-built auth state suitable for {@link BotOptions.auth}.
 *
 * Wraps the same shape returned by Baileys' `useMultiFileAuthState`. Use this
 * when persisting credentials in a custom store (SQLite, Redis, S3, etc).
 *
 * @example
 * import { useMultiFileAuthState } from "@whiskeysockets/baileys";
 * const { state, saveCreds } = await useMultiFileAuthState("./auth");
 * const bot = new Bot({ auth: { state, saveCreds } });
 */
export interface AuthHandle {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

/**
 * Browser triple sent as the user-agent during the Noise handshake. WhatsApp
 * uses it to label the connected device under "Linked devices" on the phone.
 *
 * The shape is `[appName, browser, osVersion]`.
 *
 * @example
 * new Bot({ authPath: "./auth", browser: ["my-bot", "Chrome", "1.0"] });
 */
export type BrowserDescription = [
  appName: string,
  browser: string,
  osVersion: string,
];

/**
 * Constructor options for {@link Bot}.
 *
 * Exactly one of {@link BotOptions.authPath} or {@link BotOptions.auth} must
 * be provided. Everything else is optional and has sensible defaults.
 */
export interface BotOptions {
  /**
   * Directory for credential persistence, used by `useMultiFileAuthState`.
   * Mutually exclusive with {@link BotOptions.auth}.
   *
   * The directory is created on first run if missing. **Gitignore it.**
   *
   * @example
   * new Bot({ authPath: "./auth" });
   */
  authPath?: string;
  /**
   * A pre-built auth handle. Mutually exclusive with {@link BotOptions.authPath}.
   * Use this to plug in a custom credential store (SQLite, Redis, S3).
   *
   * @example
   * const auth = await loadAuthFromRedis(jobId);
   * new Bot({ auth });
   */
  auth?: AuthHandle;
  /**
   * Prefix for {@link Composer.command} matching, exposed on `ctx.prefix`.
   * Defaults to `'/'`.
   *
   * @example
   * const bot = new Bot({ authPath: "./auth", prefix: "!" });
   * bot.command("ping", (ctx) => ctx.reply("pong"));  // matches "!ping"
   */
  prefix?: string;
  /**
   * Pino logger used by wzapp itself for lifecycle messages (connecting,
   * connected, reconnecting, stopped, diagnostics). Defaults to
   * `pino({ level: "info" })`.
   *
   * Baileys' internal logger is kept silent by default; override it via
   * {@link BotOptions.makeSocketOpts} if you need to see protocol traces.
   *
   * @example
   * import pino from "pino";
   * new Bot({ authPath: "./auth", logger: pino({ level: "debug" }) });
   */
  logger?: Logger;
  /**
   * WhatsApp Web protocol version to advertise. Defaults to the result of
   * `fetchLatestBaileysVersion()`.
   *
   * Override when the upstream "latest" version returned by Baileys is being
   * rejected by WhatsApp (this happens occasionally as WA rolls out updates).
   *
   * @example
   * new Bot({ authPath: "./auth", version: [2, 3000, 1015901307] });
   */
  version?: WAVersion;
  /**
   * Browser triple sent during the Noise handshake; see
   * {@link BrowserDescription}. Defaults to `Browsers.appropriate("wzapp")`.
   *
   * @example
   * new Bot({ authPath: "./auth", browser: ["bot", "Safari", "1.0"] });
   */
  browser?: BrowserDescription;
  /**
   * Maximum number of connection attempts per {@link Bot.init} call before
   * the bot gives up.
   *
   * Each non-terminal close (515 `restartRequired`, network blips, transient
   * 5xx) consumes one attempt, so the default of `5` tolerates 4 transient
   * closes in a single `init()` call. Every call starts with a fresh budget.
   * Defaults to `5`, with a minimum of `1`.
   *
   * Terminal codes (logged out, banned, replaced) skip the counter and fail
   * immediately with a diagnostic message.
   */
  maxConnectRetries?: number;
  /**
   * Escape hatch into the raw Baileys `SocketConfig`. Receives the defaults
   * wzapp sets (auth, version, logger, browser) and may override any of them.
   *
   * Use this to access Baileys options not promoted to top-level here:
   * `qrTimeout`, `defaultQueryTimeoutMs`, `keepAliveIntervalMs`,
   * `cachedGroupMetadata`, `getMessage`, etc.
   *
   * @example
   * new Bot({
   *   authPath: "./auth",
   *   makeSocketOpts: (defaults) => ({
   *     ...defaults,
   *     qrTimeout: 60_000,
   *     keepAliveIntervalMs: 30_000,
   *     logger: pino({ level: "debug" }),  // unmute Baileys' internal logs
   *   }),
   * });
   */
  makeSocketOpts?: (defaults: Partial<SocketConfig>) => Partial<SocketConfig>;
  /** Print the connection QR to the terminal as it arrives. Defaults to `true`. */
  printQR?: boolean;
}

/**
 * Disconnect codes that are *terminal*. Retrying with the same auth state
 * will not help, the operator needs to intervene (re-pair, unban, close the
 * competing session, etc). Anything not in this set is treated as transient
 * and triggers an automatic reconnect.
 */
const TERMINAL_DISCONNECT_CODES: ReadonlySet<number> = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.forbidden,
  DisconnectReason.connectionReplaced,
  DisconnectReason.multideviceMismatch,
  DisconnectReason.badSession,
]);

/**
 * Builds a multi-line, actionable troubleshoot message for terminal disconnect
 * codes. When the auth path on disk is known, the exact `rm -rf` command is
 * embedded in the message. Otherwise the hint points at the abstract "auth
 * store" the user must clear manually.
 */
function diagnoseTerminalDisconnect(
  code: number,
  authPath: string | undefined,
  hadPriorSession: boolean,
): string {
  const wipeHint =
    authPath !== undefined
      ? `rm -rf ${authPath}`
      : "clear your auth store (delete creds.json or equivalent)";
  switch (code) {
    case DisconnectReason.loggedOut: // 401
      if (!hadPriorSession) {
        return [
          "Authentication failed on the first connection (statusCode=401).",
          "The auth dir probably contains incomplete credentials from a previous attempt.",
          `Fix: ${wipeHint}`,
          "Then run the bot again and scan the QR.",
        ].join("\n");
      }
      return [
        'Session revoked (statusCode=401). This device was logged out from the phone ("Linked devices" → remove).',
        "To reconnect:",
        `  ${wipeHint}`,
        "Then run again and scan the QR.",
      ].join("\n");
    case DisconnectReason.forbidden: // 403
      return [
        "Connection forbidden (statusCode=403). The number was likely banned, or the WA Web version is blocked.",
        "Check:",
        "  - WhatsApp still works on the phone.",
        "  - If it persists, pin a recent version via BotOptions.version.",
      ].join("\n");
    case DisconnectReason.connectionReplaced: // 440
      return [
        "Connection replaced (statusCode=440). Another process opened WhatsApp Web with the same session.",
        "Keeping two running will keep kicking each other out. Stop the other instance before starting this one again.",
      ].join("\n");
    case DisconnectReason.multideviceMismatch: // 411
      return [
        "Multi-device mismatch (statusCode=411). The saved state is out of sync with the server.",
        `Fix: ${wipeHint}`,
        "Then run again and scan the QR.",
      ].join("\n");
    case DisconnectReason.badSession: // 500
      return [
        "Corrupted session (statusCode=500). Something in the auth state is invalid.",
        `Fix: ${wipeHint}`,
        "Then run again and scan the QR.",
      ].join("\n");
    default:
      return `Connection closed with an unmapped terminal code (statusCode=${code}).`;
  }
}

/**
 * Options for {@link Bot.start}.
 */
export interface StartOptions {
  /**
   * Maximum number of updates processed concurrently by the runner.
   * Defaults to `16` if omitted.
   *
   * Each update is a separate middleware invocation, so this is effectively
   * the maximum parallel handler executions. See
   * {@link RunnerOptions.concurrency} for the trade-offs of higher values.
   *
   * @example
   * await bot.start({ concurrency: 32 });
   */
  concurrency?: number;
}

/**
 * The main bot class. Extends {@link Composer} so every middleware method
 * (`.use`, `.on`, `.command`, `.hears`, etc.) is available directly on the
 * instance, mirroring grammY's `Bot`.
 *
 * The bot owns:
 *
 * 1. A Baileys `WASocket` (created in {@link Bot.init}), with a wrapper
 *    {@link Api} exposed at `ctx.api`.
 * 2. A concurrent {@link Runner} that dispatches updates into the composed
 *    middleware stack.
 * 3. The auto-reconnect loop, which absorbs the `restartRequired (515)`
 *    Baileys fires right after the first QR scan, and recovers from network
 *    blips without surfacing errors.
 *
 * @example
 * import { Bot } from "@almeidamateus/wzapp";
 *
 * const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");
 *
 * bot.command("start", (ctx) => ctx.reply("hi"));
 * bot.on("message:image", (ctx) => ctx.react("📷"));
 *
 * bot.catch((err) => console.error("bot error:", err));
 * await bot.start();
 *
 * @example
 * // Graceful shutdown on SIGINT:
 * process.on("SIGINT", async () => {
 *   await bot.stop();
 *   process.exit(0);
 * });
 *
 * @example
 * // Custom context type:
 * interface MyContext extends Context {
 *   sessionData?: { userId: string };
 * }
 * const bot = new Bot<MyContext>({ authPath: "./auth" });
 */
export class Bot<
  C extends Context = Context,
  Q extends FilterQuery = FilterQuery,
> extends Composer<C, Q> {
  private readonly authPath?: string;
  private readonly userAuth?: AuthHandle;
  private readonly prefix: string;
  private readonly logger: Logger;
  private readonly userVersion?: WAVersion;
  private readonly userBrowser?: BrowserDescription;
  private readonly maxConnectRetries: number;
  private readonly makeSocketOpts: BotOptions["makeSocketOpts"];
  private readonly printQR: boolean;

  private _sock?: WASocket;
  private _api?: Api;
  private authState?: AuthHandle;
  private resolvedVersion?: WAVersion;
  private me: { id: string; name?: string; lid?: string } = { id: "" };

  private runner?: Runner<WhatsappUpdate>;
  private running = false;
  private starting = false;
  private stopping = false;
  private connectedOnce = false;
  private listenersAttached = false;
  private listeners: Array<{ event: keyof BaileysEventMap; fn: (...args: unknown[]) => void }> = [];

  private startResolve?: () => void;
  private startPromise?: Promise<void>;

  private errorHandler: ErrorHandler<C> = defaultErrorHandler;

  constructor(opts: BotOptions) {
    super();
    if (!opts.authPath && !opts.auth) {
      throw new Error(
        "Bot: provide either `authPath` (string) or `auth` ({ state, saveCreds })",
      );
    }
    if (opts.authPath && opts.auth) {
      throw new Error(
        "Bot: `authPath` and `auth` are mutually exclusive, pick one",
      );
    }
    if (opts.authPath !== undefined) this.authPath = opts.authPath;
    if (opts.auth !== undefined) this.userAuth = opts.auth;
    this.prefix = opts.prefix ?? "/";
    this.logger = opts.logger ?? pino({ level: "info" });
    if (opts.version !== undefined) this.userVersion = opts.version;
    if (opts.browser !== undefined) this.userBrowser = opts.browser;
    this.maxConnectRetries = Math.max(1, opts.maxConnectRetries ?? 5);
    this.makeSocketOpts = opts.makeSocketOpts;
    this.printQR = opts.printQR ?? true;
  }

  /**
   * The {@link Api} façade over the current Baileys socket. Available once
   * the connection is established (after {@link Bot.init} completes, i.e.
   * once {@link Bot.start} is up and running); throws if accessed before.
   *
   * Implemented as a getter so the reference stays live across reconnects:
   * the socket (and therefore the `Api`) is recreated on transient closes,
   * but `bot.api` always points to the current one. Don't cache the result;
   * read `bot.api.X(...)` directly each time.
   *
   * Use this for off-band sends from cron jobs, webhooks, or scripts that
   * don't have a `ctx` available.
   *
   * @example
   * void bot.start();  // resolves only on stop(), so don't await it here
   * setInterval(() => {
   *   bot.api.sendMessage("5511...@s.whatsapp.net", { text: "tick" });
   * }, 60_000);
   */
  get api(): Api {
    if (!this._api) {
      throw new Error(
        "Bot.api accessed before start(). Call bot.start() first.",
      );
    }
    return this._api;
  }

  /**
   * The raw Baileys `WASocket`. Same lifecycle as {@link Bot.api}: available
   * once the connection is established, recreated on reconnect, do not cache.
   *
   * Escape hatch for Baileys methods we don't wrap in {@link Api}.
   *
   * @example
   * bot.command("subject", async (ctx) => {
   *   const meta = await bot.sock.groupMetadata("group@g.us");
   *   await ctx.reply(meta.subject);
   * });
   */
  get sock(): WASocket {
    if (!this._sock) {
      throw new Error(
        "Bot.sock accessed before start(). Call bot.start() first.",
      );
    }
    return this._sock;
  }

  /**
   * Establishes the WhatsApp connection.
   *
   * Loops over an internal `openOnce` step so that transient closes (most
   * notably the `restartRequired (515)` that Baileys emits right after a
   * successful QR scan) are absorbed without bubbling out to the caller.
   * Only terminal codes (logged out, banned, replaced, etc) or exceeding
   * {@link BotOptions.maxConnectRetries} surface as a rejection.
   *
   * Idempotent: if the bot is already connected, returns immediately.
   *
   * Usually you don't call this directly. {@link Bot.start} does it for you.
   * Use it manually only if you want to keep the bot online without engaging
   * the runner (e.g., to validate the auth state alone).
   *
   * @throws An `Error` with the troubleshoot text already appended when the
   * connection ends in a terminal code (401, 403, 411, 440, 500) or when the
   * retry budget is exhausted.
   */
  async init(): Promise<void> {
    if (this._sock && this.connectedOnce) return;

    this.logger.info("connecting to WhatsApp…");

    // Resolve auth lazily so the constructor can stay sync. Same handle is
    // reused across retries and for the lifetime of the Bot instance.
    if (!this.authState) {
      if (this.userAuth) {
        this.authState = this.userAuth;
      } else if (this.authPath !== undefined) {
        this.authState = await useMultiFileAuthState(this.authPath);
      } else {
        // Unreachable: constructor enforces one-of.
        throw new Error("Bot: missing auth configuration");
      }
    }

    if (!this.resolvedVersion) {
      this.resolvedVersion =
        this.userVersion ?? (await fetchLatestBaileysVersion()).version;
    }

    for (let attempt = 1; attempt <= this.maxConnectRetries; attempt++) {
      try {
        const outcome = await this.openOnce();
        if (outcome === "open") {
          this.connectedOnce = true;
          this.logger.info({ me: this.me.id }, "connected");
          return;
        }
        this.logger.info(
          { attempt, reason: outcome.reason },
          "transient disconnect, reconnecting",
        );
      } catch (err) {
        // Terminal disconnect: append a troubleshoot block before bubbling.
        const code = extractStatusCode(err);
        if (code !== undefined) {
          const hadPriorSession = Boolean(this.authState.state.creds.me);
          const hint = diagnoseTerminalDisconnect(
            code,
            this.authPath,
            hadPriorSession,
          );
          this.logger.error({ statusCode: code }, "terminal disconnect");
          throw new Error(`wzapp: connection failed.\n\n${hint}`);
        }
        throw err;
      }
    }

    throw new Error(
      `wzapp: failed to connect after ${this.maxConnectRetries} attempts`,
    );
  }

  /**
   * One end-to-end attempt at bringing the socket up. Resolves to `'open'`
   * once the connection is established (with `this.me` populated and the
   * socket installed on `this._sock`/`this._api`), or to `{ reason }` when
   * the connection closes with a non-terminal code (caller should retry).
   * Rejects only on terminal codes.
   */
  private async openOnce(): Promise<"open" | { reason: number | "unknown" }> {
    const authState = this.authState;
    if (!authState) throw new Error("Bot: openOnce called without authState");

    const defaults: Partial<SocketConfig> = {
      auth: authState.state,
      version: this.resolvedVersion,
      // Baileys is extremely chatty at info level (signal protocol, retries,
      // stanza tracing). Keep it silent by default. Users who want it can
      // override via `makeSocketOpts`.
      logger: pino({ level: "silent" }),
      browser: this.userBrowser ?? Browsers.appropriate("wzapp"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
    };
    const config = this.makeSocketOpts
      ? this.makeSocketOpts(defaults)
      : defaults;

    const sock = makeWASocket(config as SocketConfig);
    this._sock = sock;
    this._api = new Api(sock);

    sock.ev.on("creds.update", authState.saveCreds);

    return new Promise<"open" | { reason: number | "unknown" }>(
      (resolve, reject) => {
        const onUpdate = (state: Partial<ConnectionState>) => {
          if (state.qr && this.printQR) {
            qrcode.generate(state.qr, { small: true });
          }

          if (state.connection === "open") {
            sock.ev.off("connection.update", onUpdate);
            const meId = sock.user?.id ?? "";
            const lid = sock.user?.lid;
            const name = sock.user?.name;
            this.me = {
              id: meId,
              ...(name !== undefined ? { name } : {}),
              ...(lid !== undefined ? { lid } : {}),
            };
            resolve("open");
            return;
          }

          if (state.connection === "close") {
            sock.ev.off("connection.update", onUpdate);
            const code = (state.lastDisconnect?.error as
              | { output?: { statusCode?: number } }
              | undefined)?.output?.statusCode;

            // Tear down this socket; caller decides whether to retry.
            try {
              sock.end(undefined);
            } catch {
              // already closed
            }
            this._sock = undefined;
            this._api = undefined;

            if (code !== undefined && TERMINAL_DISCONNECT_CODES.has(code)) {
              reject(
                new Error(
                  `wzapp: terminal disconnect during init (statusCode=${code})`,
                ),
              );
              return;
            }
            resolve({ reason: code ?? "unknown" });
          }
        };
        sock.ev.on("connection.update", onUpdate);
      },
    );
  }

  /**
   * Same as {@link Composer.ignore} but preserves the `Bot<...>` type on the
   * return, so lifecycle methods (`.start`, `.stop`, `.catch`) stay
   * accessible after chaining.
   *
   * @example
   * const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");
   * await bot.start();  // still works because the return type is Bot<...>
   */
  override ignore<S extends IgnorableQuery & Q>(
    query: S | readonly S[],
  ): Bot<C, Exclude<Q, S>> {
    super.ignore(query);
    return this as unknown as Bot<C, Exclude<Q, S>>;
  }

  /**
   * Connects the bot and starts dispatching updates.
   *
   * Internally:
   * 1. Calls {@link init} (which may absorb transient disconnects).
   * 2. Creates a {@link Runner} with `concurrency` parallel workers.
   * 3. Wires every relevant Baileys event into the runner.
   *
   * Returns a `Promise` that resolves only when {@link stop} is called. This
   * mirrors grammY's `bot.start()` and lets you `await` the bot's lifetime in
   * top-level code.
   *
   * Calling `start()` again once the bot is running returns the same
   * lifetime promise. A call made while a previous `start()` is still
   * connecting instead returns a promise that resolves immediately, so avoid
   * racing concurrent `start()` calls during startup.
   *
   * @example
   * const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");
   * bot.command("ping", (ctx) => ctx.reply("pong"));
   * await bot.start();  // blocks until bot.stop() is called
   */
  async start(opts: StartOptions = {}): Promise<void> {
    if (this.running || this.starting) {
      if (this.startPromise) return this.startPromise;
      return;
    }
    this.starting = true;

    await this.init();

    const concurrency = opts.concurrency ?? 16;
    this.runner = new Runner<WhatsappUpdate>(
      (u) => this.handleUpdate(u),
      { concurrency },
    );

    this.attachListeners();
    this.running = true;
    this.starting = false;

    this.startPromise = new Promise<void>((resolve) => {
      this.startResolve = resolve;
    });
    return this.startPromise;
  }

  /**
   * Gracefully stops the bot. Removes Baileys event listeners, drains the
   * runner queue (so in-flight handlers finish), and closes the socket.
   *
   * Resolves the promise returned by {@link start}, which is how you await
   * the bot's lifetime in top-level code.
   *
   * Idempotent: calling it again after the bot is stopped is a no-op.
   *
   * @example
   * process.on("SIGINT", async () => {
   *   await bot.stop();
   *   process.exit(0);
   * });
   */
  async stop(): Promise<void> {
    if (!this.running || this.stopping) return;
    this.stopping = true;
    this.logger.info("stopping…");

    this.detachListeners();
    if (this.runner) {
      this.runner.stop();
      await this.runner.drain();
    }
    if (this._sock) {
      try {
        this._sock.end(undefined);
      } catch {
        // The socket may already be closed; ignore.
      }
    }
    this.running = false;
    this.stopping = false;
    this.startResolve?.();
    this.startResolve = undefined;
    this.startPromise = undefined;
    this.logger.info("stopped");
  }

  /**
   * Registers a global error handler. Any error thrown by a middleware that
   * is not caught by an {@link Composer.errorBoundary} reaches here.
   *
   * Replaces any prior handler (only one is active at a time). The default
   * behavior is to log to stderr with `[wzapp]` prefix.
   *
   * The handler receives a {@link BotError} that wraps the original error
   * and includes the `ctx` that was being processed.
   *
   * @example
   * bot.catch((err) => {
   *   console.error(`error processing ${err.ctx.update.type}:`, err.error);
   * });
   */
  catch(handler: ErrorHandler<C>): void {
    this.errorHandler = handler;
  }

  /**
   * Builds a {@link Context} for the supplied update and drives the middleware
   * stack to completion. Errors thrown anywhere in the chain are routed to
   * the registered error handler (default: log to stderr).
   *
   * Called automatically by the runner. You only need this directly for
   * testing or for advanced replay scenarios where you have a synthetic
   * `WhatsappUpdate` and want to push it through the bot's pipeline.
   *
   * @example
   * // In a vitest test:
   * const fakeUpdate: WhatsappUpdate = { type: "message", message: ... };
   * await bot.handleUpdate(fakeUpdate);
   * expect(myMock).toHaveBeenCalled();
   */
  async handleUpdate(update: WhatsappUpdate): Promise<void> {
    if (!this._sock || !this._api) {
      throw new Error("Bot.handleUpdate called before init()");
    }
    const ctx = new Context({
      update,
      api: this._api,
      me: this.me,
      sock: this._sock,
      prefix: this.prefix,
    }) as unknown as C;

    try {
      await this.middleware()(ctx, async () => undefined);
    } catch (err) {
      try {
        await this.errorHandler(new BotError<C>(err, ctx));
      } catch (handlerErr) {
        // Last-resort: don't let the error handler take the runner down.
        this.logger.error({ err: handlerErr }, "errorHandler itself threw");
      }
    }
  }

  // ─── Internal: Baileys event wiring ───

  private attachListeners(): void {
    if (this.listenersAttached || !this._sock) return;
    const sock = this._sock;

    const push = (updates: WhatsappUpdate[]) => {
      if (!this.runner) return;
      for (const u of updates) this.runner.push(u);
    };

    const on = <K extends keyof BaileysEventMap>(
      event: K,
      fn: (arg: BaileysEventMap[K]) => void,
    ) => {
      sock.ev.on(event, fn);
      this.listeners.push({ event, fn: fn as (...args: unknown[]) => void });
    };

    on("messages.upsert", (p) => push(fromMessagesUpsert(p)));
    on("messages.update", (p) => push(fromMessagesUpdate(p)));
    on("messages.reaction", (p) => push(fromMessagesReaction(p)));
    on("messages.delete", (p) => push(fromMessagesDelete(p)));
    on("message-receipt.update", (p) => push(fromMessageReceipt(p)));
    on("presence.update", (p) => push(fromPresenceUpdate(p)));
    on("groups.upsert", (p) => push(fromGroupsUpsert(p)));
    on("groups.update", (p) => push(fromGroupsUpdate(p)));
    on("group-participants.update", (p) => push(fromGroupParticipantsUpdate(p)));
    on("chats.upsert", (p) => push(fromChatsUpsert(p)));
    on("chats.update", (p) => push(fromChatsUpdate(p)));
    on("chats.delete", (p) => push(fromChatsDelete(p)));
    on("contacts.upsert", (p) => push(fromContactsUpsert(p)));
    on("contacts.update", (p) => push(fromContactsUpdate(p)));
    on("call", (p) => push(fromCall(p)));
    on("blocklist.update", (p) => push(fromBlocklistUpdate(p)));

    on("connection.update", (state) => {
      push(fromConnectionUpdate(state));
      if (state.qr && this.printQR) {
        qrcode.generate(state.qr, { small: true });
      }
      if (state.connection === "close") {
        const code = (state.lastDisconnect?.error as
          | { output?: { statusCode?: number } }
          | undefined)?.output?.statusCode;
        const isTerminal =
          code !== undefined && TERMINAL_DISCONNECT_CODES.has(code);

        if (isTerminal) {
          const hadPriorSession = Boolean(this.authState?.state.creds.me);
          const hint = diagnoseTerminalDisconnect(
            code as number,
            this.authPath,
            hadPriorSession,
          );
          this.logger.error(
            { statusCode: code },
            `terminal disconnect, stopping\n${hint}`,
          );
          void this.stop();
          return;
        }

        if (this.running) {
          // Transient close: tear down the socket but keep the runner & queue.
          this.logger.info({ code }, "connection lost, reconnecting");
          this.detachListeners();
          this.connectedOnce = false;
          this._sock = undefined;
          this._api = undefined;
          this.init()
            .then(() => this.attachListeners())
            .catch((err) => {
              this.logger.error({ err }, "reconnect failed, stopping");
              void this.stop();
            });
        }
      }
    });

    this.listenersAttached = true;
  }

  private detachListeners(): void {
    if (!this.listenersAttached || !this._sock) return;
    const sock = this._sock;
    for (const { event, fn } of this.listeners) {
      sock.ev.off(event, fn as never);
    }
    this.listeners = [];
    this.listenersAttached = false;
  }
}

function defaultErrorHandler(err: BotError): MaybePromise<void> {
  // eslint-disable-next-line no-console
  console.error("[wzapp] uncaught middleware error:", err);
}

/** Pull a Boom-style `output.statusCode` out of an error, if present. */
function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  // Direct match: an Error thrown with the statusCode embedded in the message.
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string") {
    const m = message.match(/statusCode=(\d+)/);
    if (m && m[1]) return Number(m[1]);
  }
  // Boom-ish shape.
  const output = (err as { output?: { statusCode?: number } }).output;
  if (output && typeof output.statusCode === "number") return output.statusCode;
  return undefined;
}
