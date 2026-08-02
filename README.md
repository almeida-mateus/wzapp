# wzapp

[![npm version](https://img.shields.io/npm/v/@almeidamateus/wzapp)](https://www.npmjs.com/package/@almeidamateus/wzapp)

> A **grammY**-style framework for **WhatsApp** bots, built on top of **Baileys**.

Composable middleware, typed filter queries, a concurrent runner, and an ergonomic context. The grammY developer experience brought to WhatsApp Web (multi-device).

```ts
import { Bot } from "@almeidamateus/wzapp";

const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");

bot.command("start", (ctx) =>
  ctx.reply(`Hi, ${ctx.senderName ?? "friend"}!`),
);

bot.on("message:image", async (ctx) => {
  const buf = await ctx.downloadMedia();
  await ctx.replyWithImage(buf, { caption: `Received ${buf.length} bytes` });
});

await bot.start();
```

---

## Current status: v0.1

The core works:

- ✅ `Bot` and `Composer` with full middleware (`use`, `on`, `command`, `hears`, `chatType`, `filter`, `drop`, `branch`, `fork`, `lazy`, `route`, `errorBoundary`).
- ✅ Typed filter queries with narrowing.
- ✅ `Context` with lazy getters and around 20 reply, group, and media helpers.
- ✅ Concurrent runner (queue plus workers).
- ✅ Automatic reconnection, including the invisible `restartRequired (515)`.
- ✅ Friendly diagnostics for terminal disconnects (401, 403, 440, and others).
- ✅ Typed `.ignore()` for cutting off the bot's own message echoes.

For known gaps, see [Baileys coverage](#baileys-coverage).

---

## Installation

```sh
yarn add @almeidamateus/wzapp
# or
npm install @almeidamateus/wzapp
```

`@whiskeysockets/baileys`, `pino`, and `qrcode-terminal` are direct dependencies, so you don't need to install them separately.

Requires **Node 18 or newer**.

---

## Quick start

```sh
mkdir my-bot && cd my-bot
yarn init -y
yarn add @almeidamateus/wzapp tsx typescript
yarn add -D @types/node
```

`src/index.ts`:

```ts
import { Bot } from "@almeidamateus/wzapp";

const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");

bot.command("ping", (ctx) => ctx.reply("pong"));
bot.hears(/^hi$/i, (ctx) => ctx.reply("hey!"));

bot.catch((err) => console.error("error:", err));
await bot.start();
```

```sh
yarn tsx src/index.ts
```

Scan the QR code that appears in the terminal. The `./auth/` folder holds your credentials, so make sure to gitignore it.

If something goes wrong on the first attempt (corrupted auth, account logged out), the bot prints a message with the exact `rm -rf` command that fixes it.

---

## Concepts

### Bot lifecycle

```ts
const bot = new Bot({ authPath: "./auth" });
process.on("SIGINT", () => bot.stop());  // drains the queue and closes the socket
await bot.start();   // blocks until bot.stop() is called
```

`start()` returns the bot's lifetime promise: it resolves when `stop()` is called, mirroring grammY. Calling `start()` again once the bot is running returns the same promise (avoid racing concurrent calls during startup). `stop()` is idempotent: calling it after the bot stopped is a no-op.

The first connection (no credentials) goes through `connect`, `QR`, `scan`, `close[515]`, `reconnect`, and finally `open`. The `close[515]` is absorbed transparently inside `init()`, so you never see an error.

### Authentication

Two options:

**Local file** (default):
```ts
new Bot({ authPath: "./auth" });
```
This uses Baileys' `useMultiFileAuthState` under the hood.

**Storage-backed** (Redis, S3, SQL, any string key-value backend):
```ts
import { Bot, storageAuthState, type AuthStorage } from "@almeidamateus/wzapp";
import { createClient } from "redis";

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const storage: AuthStorage = {
  get: (key) => redis.get(`wa:${key}`),
  set: async (key, value) => { await redis.set(`wa:${key}`, value); },
  delete: async (key) => { await redis.del(`wa:${key}`); },
  getMany: (keys) => redis.mGet(keys.map((k) => `wa:${k}`)),
};

const bot = new Bot({ auth: await storageAuthState(storage) });
```

`AuthStorage` is three methods (`get`, `set`, `delete` over strings) plus optional batch fast paths (`getMany`, `setMany`), so any backend becomes an adapter in a dozen lines. The session lives entirely in the backend and no files are written. The signal key store is wrapped in Baileys' in-memory cache by default, so the backend only sees a fraction of the reads.

**Custom auth handle**:
```ts
import { Bot, type AuthHandle } from "@almeidamateus/wzapp";

const auth: AuthHandle = await myCustomAuth();
new Bot({ auth });
```

`AuthHandle` is `{ state: AuthenticationState; saveCreds: () => Promise<void> }`, the same shape that `useMultiFileAuthState` returns.

### Middleware

Every registered function is a `(ctx, next) => Promise<unknown>`. It follows the onion pattern from grammY and Koa: each middleware decides whether to call `next()` to pass control down the chain.

```ts
bot.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  console.log(`processed in ${Date.now() - start}ms`);
});

bot.on("message:text", (ctx) => ctx.reply(ctx.text));
```

Registration order matters. The first `.use` or `.on` you register runs first.

### Filter queries

A string DSL of the form `<type>:<sub>:<sub>` that matches against the discriminated `WhatsappUpdate` type. Arrays mean OR.

```ts
bot.on("message:text", h);                       // text only
bot.on(["message:image", "message:video"], h);   // OR
bot.on("group:participants:add", h);             // someone joined
bot.on("connection:open", h);                    // connection opened
```

**Full catalog:**

| Category | Queries |
|---|---|
| Message | `message`, `msg`, `text`, `media` |
| Message type | `message:text`, `message:image`, `message:video`, `message:audio`, `message:voice`, `message:document`, `message:sticker`, `message:sticker:animated`, `message:contact`, `message:location`, `message:location:live`, `message:reaction`, `message:poll`, `message:poll:vote`, `message:button_reply`, `message:list_reply`, `message:group_invite` |
| Message predicates | `message:quoted`, `message:mention`, `message:from_me`, `message:forwarded`, `message:caption`, `message:private`, `message:group`, `message:broadcast` |
| Edits | `message_edit` |
| Deletes and receipts | `message_delete`, `message_receipt` |
| Reactions | `reaction`, `reaction:added`, `reaction:removed` |
| Presence | `presence`, `presence:typing`, `presence:recording`, `presence:paused`, `presence:available`, `presence:unavailable` |
| Groups | `group_metadata`, `group_metadata:upsert`, `group_metadata:update`, `group:participants:add`, `group:participants:remove`, `group:participants:promote`, `group:participants:demote` |
| Chat | `chat:upsert`, `chat:update`, `chat:delete` |
| Contact | `contact:upsert`, `contact:update` |
| Connection | `connection`, `connection:open`, `connection:close`, `connection:connecting`, `connection:qr`, `connection:pairing_code` |
| Calls | `call`, `call:offer`, `call:accept`, `call:reject`, `call:timeout` |
| Blocklist | `blocklist`, `blocklist:add`, `blocklist:remove` |

**Aliases:**
- `msg` resolves to `message`.
- `text` resolves to `message:text`.
- `media` expands to `message:image|video|audio|voice|document|sticker` (OR).

### Narrowing

`bot.on(query, ...)` narrows the handler's `ctx` all the way down to the
specific message content the query matches. No optional chaining, no
`if (ctx.text)` guards.

```ts
bot.on("message:text", (ctx) => {
  const text: string = ctx.text;        // string, not string | undefined
});

bot.on("message:image", (ctx) => {
  // `imageMessage` is guaranteed present on the inner message:
  const width = ctx.update.message.message.imageMessage.width;
});

bot.on("message:voice", (ctx) => {
  // `ptt` is the literal `true`, not boolean | null | undefined:
  const ptt: true = ctx.update.message.message.audioMessage.ptt;
});

bot.on("message:quoted", (ctx) => {
  const q: QuotedMessage = ctx.quoted;   // not QuotedMessage | undefined
});

bot.on("message:from_me", (ctx) => {
  const isMe: true = ctx.isFromMe;       // literal true
});
```

Array (OR) form widens correctly: handlers registered with
`bot.on(["message:image", "message:video"], h)` see fields that exist in both
variants as concrete, and ones that don't as optional.

Registering an invalid query is a compile error:

```ts
bot.on("mesage:text", h);  // ❌ does not compile, TS catches the typo
```

### `.command` and `.hears`

```ts
bot.command("start", (ctx) => ctx.reply("hi"));
bot.command(["help", "ajuda"], (ctx) => ctx.reply("commands: ..."));

// RegExp match:
bot.command(/^cep[\s-]?(\d{5})/, (ctx) => {
  const cep = (ctx.match as RegExpMatchArray)[1];
  // ...
});

// .hears matches free text (no command prefix)
bot.hears("hi", (ctx) => ctx.reply("hey"));
bot.hears(/who (.+)/i, (ctx) => {
  const what = (ctx.match as RegExpMatchArray)[1];
  // ...
});
```

The default command prefix is `/`. You can override it:
```ts
new Bot({ authPath: "./auth", prefix: "!" });
```

### `.filter` and `.drop`

Arbitrary predicates:

```ts
bot.filter((ctx) => ctx.isGroup, async (ctx) => {
  // runs in groups only
});

bot.drop((ctx) => ctx.from === "spam@s.whatsapp.net");
// updates from that JID never reach the handlers below
```

### `.chatType` (shortcut)

```ts
bot.chatType("private", (ctx) => ctx.reply("DMs only"));
bot.chatType(["group", "broadcast"], (ctx) => ctx.reply("not a DM"));
```

### Composition (advanced)

```ts
bot.branch(
  (ctx) => ctx.isGroup,
  groupHandler,
  privateHandler,
);

bot.fork(loggingMiddleware);  // runs in parallel, doesn't block next

bot.lazy(async (ctx) => {
  const config = await loadConfig(ctx.chat);
  return config.handler;
});

bot.route(
  (ctx) => ctx.text?.split(" ")[0],
  {
    "/help": helpHandler,
    "/about": aboutHandler,
  },
  fallbackHandler,
);

bot.errorBoundary(
  (err) => console.error("inside the boundary:", err),
  riskyHandler,
);
```

### Context

```ts
ctx.update           // discriminated WhatsappUpdate
ctx.api              // façade over WASocket (use raw for plain Baileys)
ctx.sock             // direct WASocket (escape hatch)
ctx.me               // { id, name?, lid? } for the bot
ctx.match            // result from .command or .hears

// Getters (only meaningful for message updates):
ctx.chat             // chat JID
ctx.from             // sender JID (in groups, this is the participant)
ctx.senderName       // pushName
ctx.messageId
ctx.text             // text (conversation / extendedTextMessage)
ctx.caption          // caption (image, video, document)
ctx.quoted           // quoted message, if any
ctx.mentions         // array of mentioned JIDs
ctx.isGroup
ctx.isPrivate
ctx.isBroadcast
ctx.isFromMe
```

### Reply helpers

All of them quote the original message by default. To opt out, pass `{ quote: false }`.

```ts
ctx.reply("text", { mentions: ["..."] });
ctx.replyWithImage(buffer, { caption: "..." });
ctx.replyWithVideo(buffer, { caption: "...", gifPlayback: false });
ctx.replyWithAudio(buffer, { ptt: true });
ctx.replyWithDocument(buffer, { fileName: "file.pdf", mimetype: "application/pdf" });
ctx.replyWithSticker(buffer, { animated: false });
ctx.replyWithLocation(-23.5505, -46.6333, { name: "Sé" });
ctx.replyWithContact([{ fullName: "John", vcard: "..." }]);
ctx.replyWithPoll("Pizza?", ["Yes", "No"], { selectableCount: 1 });

ctx.react("👍");          // an empty string removes the reaction
ctx.editMessage("new");    // own messages only
ctx.deleteMessage(true);   // forEveryone

ctx.forwardTo(["xx@s.whatsapp.net"]);
const buf = await ctx.downloadMedia();
await ctx.markAsRead();
await ctx.sendPresence("composing");

// Utilities for the current chat:
await ctx.subscribePresence();
const avatarUrl = await ctx.fetchProfilePictureUrl();
```

### Group helpers

These throw if `!ctx.isGroup`.

```ts
const meta = await ctx.getGroupMetadata();
await ctx.addParticipants(["xx@s.whatsapp.net"]);
await ctx.removeParticipants([...]);
await ctx.promote([...]);
await ctx.demote([...]);
await ctx.updateGroupSubject("New name");
await ctx.updateGroupDescription("New description");
await ctx.leaveGroup();
```

### Polls

Sending and detecting polls works out of the box (`ctx.replyWithPoll`, `message:poll`, `message:poll:vote`). Reading votes takes one extra step: WhatsApp encrypts each vote with a key that only exists inside the poll creation message, so persist that message and hand it back when a vote arrives.

For polls the bot creates, persist the return value of `ctx.replyWithPoll`:

```ts
bot.command("poll", async (ctx) => {
  const poll = await ctx.replyWithPoll("Pizza?", ["yes", "no"]);
  await db.set(poll.key.id!, JSON.stringify(poll));
});
```

For polls created by others, store them from a `message:poll` handler, and decrypt votes as they arrive:

```ts
bot.on("message:poll", (ctx) => {
  return db.set(ctx.messageId, JSON.stringify(ctx.update.message));
});

bot.on("message:poll:vote", async (ctx) => {
  const creation = JSON.parse(await db.get(ctx.pollCreationKey.id));
  const { voter, selectedOptions } = ctx.decryptPollVote(creation);
  // selectedOptions: ["rock", "jazz"]
});
```

Don't rely on `message:poll` to capture the bot's own polls: with the usual `.ignore("message:from_me")` setup, the creation echo is dropped before it reaches any handler. That is why the bot's own polls are persisted from the `replyWithPoll` return value.

Store the creation message in whatever backend you already have: a plain `JSON.stringify` round-trip is enough, binary fields included.

Each vote event carries the voter's entire current selection: voting again replaces it, and an empty `selectedOptions` means the vote was retracted. `decryptPollVote` throws when a vote cannot be authenticated (a mismatched or missing creation message, for example), so guard the call with a try/catch or an `errorBoundary` if one bad vote must not break the handler chain. The standalone `readPollVote` function is exported for use outside a handler.

---

## The echo gotcha: `.ignore("message:from_me")`

WhatsApp is multi-device. The bot is just another device on your account. When the bot sends a message, it comes back as `messages.upsert` with `key.fromMe: true`, because in the protocol's view that message "arrived" on every device tied to the account, including the bot that sent it.

Without filtering, that turns into a loop:

```ts
bot.on("message:image", async (ctx) => {
  await ctx.replyWithImage(buf, { caption: "..." });
  // your image comes back as messages.upsert (fromMe=true)
  // → the handler fires again
  // → sends another image
  // → ...
});
```

The fix: call `.ignore("message:from_me")` at construction. It inserts a middleware that drops updates with `fromMe`, and the typing makes it a compile error to register a handler for `"message:from_me"` after the call.

```ts
const bot = new Bot({ authPath: "./auth" }).ignore("message:from_me");

bot.on("message:image", echo);    // fires only on incoming images
bot.on("message:from_me", h);     // ❌ compile error, already ignored
```

Want to listen to your own messages (for auditing or similar)? Register the handler before the `.ignore`:

```ts
const bot = new Bot({ authPath: "./auth" });

bot.on("message:from_me", (ctx) => {
  console.log(`[self] -> ${ctx.chat}: ${ctx.text}`);
});

bot.ignore("message:from_me");  // from here on, fromMe is filtered out

bot.command("start", ...);
bot.on("message:image", echo);
```

Other queries that `.ignore` accepts: `"message:broadcast"` (skips status and broadcast lists) and `"message:forwarded"` (skips forwarded messages).

---

## Connection diagnostics

User-error disconnect codes turn into actionable messages:

```
wzapp: connection failed.

Authentication failed on the first connection (statusCode=401).
The auth dir probably contains incomplete credentials from a previous attempt.
Fix: rm -rf ./auth
Then run the bot again and scan the QR.
```

This covers 401 (logged out or corrupted auth), 403 (banned), 440 (session replaced), 411 (mismatch), and 500 (bad session). The message shows up both during `init` and when these happen at runtime.

---

## `Bot` options

```ts
new Bot({
  authPath: "./auth",                    // OR auth: { state, saveCreds }
  prefix: "/",                           // prefix for .command
  logger: pino({ level: "info" }),       // pino logger, defaults to info
  version: [2, 3000, 1015901307],        // WA Web version (defaults to fetchLatest)
  browser: ["wzapp", "Chrome", "1.0"],    // user-agent for the handshake
  maxConnectRetries: 5,                  // connection attempts per init() call
  printQR: true,                         // print the QR in the terminal
  makeSocketOpts: (defaults) => ({       // escape hatch for any SocketConfig
    ...defaults,
    qrTimeout: 60_000,
    keepAliveIntervalMs: 30_000,
  }),
});

bot.start({ concurrency: 16 });          // parallel workers in the runner
```

---

## Differences from grammY

- Filter queries are WhatsApp ones (`message:image`, `group:participants:add`, etc.), not Telegram.
- `ctx.reply()` quotes the original message by default. To opt out, use `{ quote: false }`.
- WhatsApp echoes your own outgoing messages (multi-device). Use `.ignore("message:from_me")`. This doesn't exist in grammY because Telegram has no equivalent.
- The runner is built into `Bot`. It's not a separate package like `@grammyjs/runner`.

---

## Baileys coverage

Philosophy: cover what every bot needs, and expose the rest through an escape hatch (`ctx.sock`, `ctx.api.raw`). Same strategy grammY uses with `bot.api.raw`.

### Covered

| Area | Via |
|---|---|
| Events: messages, reactions, edits, deletes, receipts, presence, groups, group-participants, chats, contacts, calls, blocklist, connection | Discriminated `WhatsappUpdate` plus the filter DSL |
| Sending: text, image, video, audio, voice, document, sticker, location, contact, poll | `ctx.reply*` |
| Message ops: react, edit, delete, forward, download, markAsRead, sendPresence | `ctx.*` |
| Groups: metadata, add/remove/promote/demote, subject, description, leave | `ctx.*` |
| Utilities: `onWhatsApp`, `fetchProfilePictureUrl`, `subscribePresence` | `ctx.api.*`, `ctx.subscribePresence()`, `ctx.fetchProfilePictureUrl()` |

### To be added when demand shows up

- `createGroup`, `groupInviteCode`, `groupRevokeInvite`, `groupAcceptInvite`, `groupSettingUpdate`, `groupToggleEphemeral`, `groupFetchAllParticipating`.
- `updateProfileName`, `Status`, `Picture`.
- `messaging-history.set` as a new `WhatsappUpdate` variant.
- `chatModify` helpers (archive, pin, star, mute).
- `updateBlockStatus`, `fetchBlocklist`.
- `fetchStatus(jid)` (status text from third parties).

### Not planned

- Full interactive UI (`buttons`, `interactiveButtons`, `list`, `templateButtons`). Deprecated by WhatsApp.
- `productMessage` and catalog (Business). Regional niche.
- `offerCall`, `rejectCall`. Effectively dead feature.

Everything in this last list (and anything else not mentioned) is still reachable via `ctx.sock`:

```ts
bot.on("message:text", async (ctx) => {
  // Full Baileys API through the escape hatch:
  const [info] = await ctx.sock.onWhatsApp("5511999999999@s.whatsapp.net");
  if (info?.exists) await ctx.reply("That number exists!");
});
```

---

## Acknowledgements

wzapp would not exist without the work of two upstream projects.

### [grammY](https://grammy.dev) ([github](https://github.com/grammyjs/grammY))

The entire design language of wzapp is borrowed from grammY: the `Composer`, the middleware onion model, the `Context`-with-helpers pattern, the filter query DSL with type narrowing, the lifecycle of `Bot` (`init`/`start`/`stop`/`catch`), and the composition primitives (`branch`, `fork`, `lazy`, `route`, `errorBoundary`). The composer itself is a near-literal port of grammY's `composer.ts`, adapted to the WhatsApp update model. If you have used grammY, wzapp will feel immediately familiar.

grammY is MIT-licensed. Huge thanks to [KnorpelSenf](https://github.com/KnorpelSenf) and the grammY community for the design we leaned on.

### [Baileys](https://github.com/WhiskeySockets/Baileys)

All the heavy lifting (Noise handshake, signal-protocol encryption, multi-device protocol, media upload/download, group operations, every wire-level interaction with `web.whatsapp.com`) is done by Baileys. wzapp is a thin, opinionated wrapper on top of `WASocket`. Without Baileys there is no wzapp.

Baileys is MIT-licensed. Thanks to the [WhiskeySockets](https://github.com/WhiskeySockets) maintainers and the original author [@adiwajshing](https://github.com/adiwajshing) for keeping the WhatsApp Web reimplementation alive and current.

### Other dependencies

- [pino](https://github.com/pinojs/pino) for structured logging.
- [qrcode-terminal](https://github.com/gtanner/qrcode-terminal) for printing the pairing QR.

---

## License

MIT. See [LICENSE](LICENSE) for details.

