/**
 * Type-level tests. These don't execute at runtime; they only check that the
 * narrowed types inferred by `bot.on(...)` collapse to the precise shape we
 * promise to users.
 *
 * The file is included by `tsconfig.test.json` (excluded from the default
 * `tsconfig.json` so the production build stays clean). Running
 * `yarn typecheck:test` exercises these assertions.
 */
import { Bot, type Context } from "../src/index.js";
import type { QuotedMessage } from "../src/index.js";

const bot = new Bot({ authPath: "./auth" });

// ─── text narrows to string (not undefined) ─────────────────────────────────
bot.on("message:text", (ctx) => {
  const text: string = ctx.text;
  void text;
});

// `text` alias should narrow the same way.
bot.on("text", (ctx) => {
  const text: string = ctx.text;
  void text;
});

// ─── image: imageMessage is non-null on the inner message ──────────────────
bot.on("message:image", (ctx) => {
  // No optional chaining needed: `imageMessage` is guaranteed.
  const width: number | null | undefined = ctx.update.message.message.imageMessage.width;
  void width;
});

bot.on("message:video", (ctx) => {
  const seconds: number | null | undefined =
    ctx.update.message.message.videoMessage.seconds;
  void seconds;
});

bot.on("message:audio", (ctx) => {
  const seconds: number | null | undefined =
    ctx.update.message.message.audioMessage.seconds;
  void seconds;
});

bot.on("message:voice", (ctx) => {
  // ptt is the literal `true` on the narrowed voice variant.
  const ptt: true = ctx.update.message.message.audioMessage.ptt;
  void ptt;
});

bot.on("message:document", (ctx) => {
  const name: string | null | undefined =
    ctx.update.message.message.documentMessage.fileName;
  void name;
});

bot.on("message:sticker", (ctx) => {
  const animated: boolean | null | undefined =
    ctx.update.message.message.stickerMessage.isAnimated;
  void animated;
});

bot.on("message:sticker:animated", (ctx) => {
  const animated: true = ctx.update.message.message.stickerMessage.isAnimated;
  void animated;
});

bot.on("message:location", (ctx) => {
  const lat: number | null | undefined =
    ctx.update.message.message.locationMessage.degreesLatitude;
  void lat;
});

bot.on("message:location:live", (ctx) => {
  const lat: number | null | undefined =
    ctx.update.message.message.liveLocationMessage.degreesLatitude;
  void lat;
});

bot.on("message:reaction", (ctx) => {
  const text: string | null | undefined =
    ctx.update.message.message.reactionMessage.text;
  void text;
});

bot.on("message:poll:vote", (ctx) => {
  const enc = ctx.update.message.message.pollUpdateMessage;
  void enc;
});

bot.on("message:list_reply", (ctx) => {
  const sel = ctx.update.message.message.listResponseMessage;
  void sel;
});

bot.on("message:group_invite", (ctx) => {
  const code: string | null | undefined =
    ctx.update.message.message.groupInviteMessage.inviteCode;
  void code;
});

// ─── predicates that don't constrain inner shape but tighten getters ───────

bot.on("message:quoted", (ctx) => {
  const q: QuotedMessage = ctx.quoted;
  const id: string = q.key.id;
  void id;
});

bot.on("message:from_me", (ctx) => {
  // Both narrows: ctx.isFromMe is the literal `true`, AND
  // ctx.update.message.key.fromMe is the literal `true`.
  const isMe: true = ctx.isFromMe;
  const fromMe: true = ctx.update.message.key.fromMe;
  void isMe;
  void fromMe;
});

bot.on("message:caption", (ctx) => {
  const caption: string = ctx.caption;
  void caption;
});

bot.on("message:private", (ctx) => {
  const isPriv: true = ctx.isPrivate;
  void isPriv;
});

bot.on("message:group", (ctx) => {
  const isGroup: true = ctx.isGroup;
  void isGroup;
});

bot.on("message:broadcast", (ctx) => {
  const isBcast: true = ctx.isBroadcast;
  void isBcast;
});

// ─── Base context (no narrow) still allows undefined ───────────────────────
bot.use((ctx) => {
  const text: string | undefined = ctx.text;
  const caption: string | undefined = ctx.caption;
  const quoted: QuotedMessage | undefined = ctx.quoted;
  const isMe: boolean = ctx.isFromMe;
  void text;
  void caption;
  void quoted;
  void isMe;
  // @ts-expect-error  without a narrowing filter, ctx.text may be undefined
  const t: string = ctx.text;
  void t;
});

// ─── OR-arrays widen correctly: an image OR text query ─────────────────────
// can't promise text, because image doesn't always carry it.
bot.on(["message:text", "message:image"], (ctx) => {
  const text: string | undefined = ctx.text;
  void text;
  // @ts-expect-error  the OR includes image, so ctx.text isn't guaranteed
  const t: string = ctx.text;
  void t;
});

// ─── Negative tests via @ts-expect-error ───────────────────────────────────

bot.on("message:text", (ctx) => {
  // @ts-expect-error  ctx.text is `string`, not number
  const n: number = ctx.text;
  void n;
});

bot.on("message:from_me", (ctx) => {
  // @ts-expect-error  ctx.isFromMe is `true`, not `false`
  const f: false = ctx.isFromMe;
  void f;
});

bot.on("message:image", (ctx) => {
  // @ts-expect-error  videoMessage isn't guaranteed inside a `message:image` handler
  const v: NonNullable<unknown> = ctx.update.message.message.videoMessage;
  void v;
});

// ─── Standalone Context still types getters as the wide union ──────────────
declare const baseCtx: Context;
const baseText: string | undefined = baseCtx.text;
void baseText;
