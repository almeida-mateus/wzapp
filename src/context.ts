import type {
  AnyMessageContent,
  GroupMetadata,
  WAMessage,
  WAMessageKey,
  WASocket,
} from "@whiskeysockets/baileys";

import { Api } from "./api.js";
import {
  getCaption,
  getMentions,
  getQuoted,
  getText,
  type QuotedMessage,
} from "./helpers/message.js";
import { isBroadcastJid, isGroupJid, isPrivateJid } from "./helpers/jid.js";
import { readPollVote, type PollVote } from "./helpers/poll.js";
import type { WhatsappUpdate } from "./update.js";
import type {
  CaptionWAMessage,
  FromMeWAMessage,
  BroadcastWAMessage,
  GroupWAMessage,
  PrivateWAMessage,
  QuotedWAMessage,
  TextWAMessage,
  WAMessageWith,
} from "./filter.js";

// ─── Narrowing helper types for Context getters ───────────────────────────
//
// Each `IfNarrowed*` checks whether the wrapped update `U` is known to be a
// `message` of the corresponding narrowed variant. When it is, the getter's
// return type collapses to the concrete `T`; otherwise it falls back to `F`.

type IfText<U, T, F> = U extends { type: "message"; message: TextWAMessage } ? T : F;
type IfCaption<U, T, F> = U extends { type: "message"; message: CaptionWAMessage }
  ? T
  : F;
type IfQuoted<U, T, F> = U extends { type: "message"; message: QuotedWAMessage }
  ? T
  : F;
type IfFromMe<U, T, F> = U extends { type: "message"; message: FromMeWAMessage }
  ? T
  : F;
type IfPrivate<U, T, F> = U extends { type: "message"; message: PrivateWAMessage }
  ? T
  : F;
type IfGroup<U, T, F> = U extends { type: "message"; message: GroupWAMessage } ? T : F;
type IfPollVote<U, T, F> = U extends {
  type: "message";
  message: WAMessageWith<"pollUpdateMessage">;
}
  ? T
  : F;
type IfBroadcast<U, T, F> = U extends {
  type: "message";
  message: BroadcastWAMessage;
}
  ? T
  : F;

/**
 * Presence states accepted by {@link Context.sendPresence}.
 *
 * - `available`: bot is online and ready. Not automatic: the socket is
 *   created with `markOnlineOnConnect: false`, so the bot stays offline
 *   until this state is sent.
 * - `unavailable`: bot is offline.
 * - `composing`: shows "typing..." in the chat.
 * - `recording`: shows "recording audio..." in the chat.
 * - `paused`: clears the composing/recording indicator.
 */
export type PresenceState =
  | "available"
  | "unavailable"
  | "composing"
  | "recording"
  | "paused";

/**
 * Media payload accepted by `replyWith*` helpers. The form determines how
 * Baileys uploads the file:
 *
 * - `Buffer`: raw bytes, uploaded as-is.
 * - `string`: treated as a URL (Baileys downloads, then re-uploads).
 * - `{ url: string }`: same as the string form, more explicit.
 */
export type MediaInput = Buffer | string | { url: string };

/** Convert a {@link MediaInput} to the shape Baileys expects. */
function toMediaUpload(media: MediaInput): Buffer | { url: string } {
  if (typeof media === "string") return { url: media };
  return media;
}

/** Constructor options for {@link Context}. Built by {@link Bot.handleUpdate}. */
export interface ContextConstructorOpts<U extends WhatsappUpdate> {
  update: U;
  api: Api;
  me: { id: string; name?: string; lid?: string };
  sock: WASocket;
  prefix?: string;
}

/** Options shared by reply helpers that produce a text body. */
export interface ReplyOpts {
  /** When `false`, the reply does NOT quote the original message. Defaults to `true`. */
  quote?: boolean;
  /** JIDs to ping inside the message body. */
  mentions?: string[];
  /** When `false`, suppress the URL preview Baileys would otherwise generate. */
  linkPreview?: boolean;
}

/**
 * The `Context` object passed to every middleware. Wraps a {@link WhatsappUpdate}
 * with lazy accessors for common fields, reply helpers that auto-quote, and
 * group operations.
 *
 * The generic `U` narrows the underlying update via the filter DSL. After
 * `.on("message:image", h)`, the handler's `ctx.update` is typed as the
 * message variant only, so you can read `ctx.update.message.message.imageMessage`
 * without optional chaining.
 *
 * Most getters and helpers assume `update.type === "message"`. For other
 * update kinds, getters return safe defaults (`""`, `undefined`, `[]`);
 * message-specific methods throw.
 *
 * @example
 * bot.on("message:text", async (ctx) => {
 *   console.log(ctx.from, "said:", ctx.text);
 *   await ctx.reply(`echo: ${ctx.text}`);
 * });
 *
 * @example
 * // Group ops:
 * bot.command("kick", async (ctx) => {
 *   if (!ctx.isGroup) return ctx.reply("groups only");
 *   const target = ctx.mentions[0];
 *   if (target) await ctx.removeParticipants([target]);
 * });
 */
export class Context<U extends WhatsappUpdate = WhatsappUpdate> {
  /** The raw update; narrowed at the type level by the filter DSL. */
  public update: U;
  public readonly api: Api;
  public readonly me: { id: string; name?: string; lid?: string };
  public readonly sock: WASocket;
  /** Command prefix in use (default `/`). */
  public readonly prefix: string;
  /** Set by the composer for `.hears`/`.command` matches. */
  public match?: RegExpMatchArray | string;

  constructor(opts: ContextConstructorOpts<U>) {
    this.update = opts.update;
    this.api = opts.api;
    this.me = opts.me;
    this.sock = opts.sock;
    this.prefix = opts.prefix ?? "/";
  }

  // ───────────────────────── lazy getters ─────────────────────────

  /**
   * The chat JID this update belongs to.
   *
   * For `message`, this is `message.key.remoteJid`. For `presence` and
   * `group_participants`, the affected JID. Returns the empty string for
   * updates that don't have a chat scope (e.g. `connection`, `blocklist`).
   */
  get chat(): string {
    const u = this.update;
    switch (u.type) {
      case "message":
        return u.message.key.remoteJid ?? "";
      case "presence":
        return u.jid;
      case "group_participants":
        return u.jid;
      default:
        return "";
    }
  }

  /**
   * The sender JID for messages. In DMs this equals {@link chat}; in groups,
   * it's the participant who sent the message. Returns the empty string for
   * non-message updates.
   */
  get from(): string {
    const u = this.update;
    if (u.type !== "message") return "";
    return u.message.key.participant ?? u.message.key.remoteJid ?? "";
  }

  /**
   * The display name set by the sender on their device (`pushName`).
   *
   * May be `undefined` when WhatsApp hasn't synced the name yet, when the
   * contact is anonymous, or for non-message updates.
   */
  get senderName(): string | undefined {
    const u = this.update;
    if (u.type !== "message") return undefined;
    return u.message.pushName ?? undefined;
  }

  /** Unique message ID (`key.id`). `undefined` for non-message updates. */
  get messageId(): string | undefined {
    const u = this.update;
    if (u.type !== "message") return undefined;
    return u.message.key.id ?? undefined;
  }

  /** `true` when {@link chat} is a group JID (ends in `@g.us`). */
  get isGroup(): IfGroup<U, true, boolean> {
    return isGroupJid(this.chat) as IfGroup<U, true, boolean>;
  }

  /** `true` when {@link chat} is a one-on-one JID (`@s.whatsapp.net` or `@lid`). */
  get isPrivate(): IfPrivate<U, true, boolean> {
    return isPrivateJid(this.chat) as IfPrivate<U, true, boolean>;
  }

  /** `true` when {@link chat} is a broadcast JID (status or broadcast list). */
  get isBroadcast(): IfBroadcast<U, true, boolean> {
    return isBroadcastJid(this.chat) as IfBroadcast<U, true, boolean>;
  }

  /**
   * `true` when the wrapped message was sent by the bot itself.
   *
   * Because WhatsApp is multi-device, the bot's outgoing messages come back
   * as `messages.upsert` events with `fromMe: true`. Use
   * {@link Composer.ignore}`("message:from_me")` at the bot's root to filter
   * these out for handlers that would otherwise loop.
   */
  get isFromMe(): IfFromMe<U, true, boolean> {
    const u = this.update;
    if (u.type !== "message") return false as IfFromMe<U, true, boolean>;
    return (u.message.key.fromMe === true) as IfFromMe<U, true, boolean>;
  }

  /**
   * The textual body of a plain message, i.e. `conversation` or
   * `extendedTextMessage.text`. Returns `undefined` for media messages (use
   * {@link caption} for those) or non-message updates.
   */
  get text(): IfText<U, string, string | undefined> {
    const u = this.update;
    if (u.type !== "message") {
      return undefined as IfText<U, string, string | undefined>;
    }
    return getText(u.message) as IfText<U, string, string | undefined>;
  }

  /**
   * The caption attached to a media message (image, video, document).
   * Returns `undefined` if the message has no caption or isn't a media
   * message at all.
   */
  get caption(): IfCaption<U, string, string | undefined> {
    const u = this.update;
    if (u.type !== "message") {
      return undefined as IfCaption<U, string, string | undefined>;
    }
    return getCaption(u.message) as IfCaption<U, string, string | undefined>;
  }

  /**
   * The message being replied to, if the current message is a reply. The
   * returned object contains the quoted message's key (so you can react to
   * or delete it) and its protobuf content.
   *
   * `undefined` if the message is not a reply.
   */
  get quoted(): IfQuoted<U, QuotedMessage, QuotedMessage | undefined> {
    const u = this.update;
    if (u.type !== "message") {
      return undefined as IfQuoted<U, QuotedMessage, QuotedMessage | undefined>;
    }
    return getQuoted(u.message) as IfQuoted<
      U,
      QuotedMessage,
      QuotedMessage | undefined
    >;
  }

  /**
   * Key of the poll creation message this vote belongs to. Use it to look
   * up the stored creation message and feed
   * {@link Context.decryptPollVote}.
   *
   * `undefined` when the update is not a poll vote.
   *
   * @example
   * bot.on("message:poll:vote", async (ctx) => {
   *   const creation = await db.get(ctx.pollCreationKey.id);
   *   // ...
   * });
   */
  get pollCreationKey(): IfPollVote<U, WAMessageKey, WAMessageKey | undefined> {
    const u = this.update;
    if (u.type !== "message") {
      return undefined as IfPollVote<U, WAMessageKey, WAMessageKey | undefined>;
    }
    return (u.message.message?.pollUpdateMessage?.pollCreationMessageKey ??
      undefined) as IfPollVote<U, WAMessageKey, WAMessageKey | undefined>;
  }

  /**
   * Array of JIDs explicitly @mentioned in the message body (the contacts
   * shown highlighted in the WhatsApp client). Empty array if none, or for
   * non-message updates.
   */
  get mentions(): string[] {
    const u = this.update;
    if (u.type !== "message") return [];
    return getMentions(u.message);
  }

  // ───────────────────────── helpers ─────────────────────────

  /** Build the `{ quoted }` option for `sendMessage` based on `opts.quote`. */
  private quoteOpts(opt?: { quote?: boolean }): { quoted?: WAMessage } {
    if (opt?.quote === false) return {};
    if (this.update.type !== "message") return {};
    return { quoted: this.update.message };
  }

  /** Return the underlying `WAMessage` if this context wraps a message update. */
  private requireMessage(action: string): WAMessage {
    const u = this.update;
    if (u.type !== "message") {
      throw new Error(`${action}: no message in this update`);
    }
    return u.message;
  }

  private requireGroup(action: string): void {
    if (!this.isGroup) {
      throw new Error(`${action}: Not a group`);
    }
  }

  // ───────────────────────── replies ─────────────────────────

  /**
   * Send a text message to {@link chat}. By default the reply quotes the
   * original message (the "reply" UI in WhatsApp). Pass `{ quote: false }`
   * to send a standalone message instead.
   *
   * @example
   * bot.command("hello", (ctx) => ctx.reply(`Hi, ${ctx.senderName}!`));
   *
   * @example
   * // Mention a contact. The visible `@...` text must be the phone number;
   * // an `@lid` sender's `ctx.from` would not render as a mention.
   * const jid = "5511999999999@s.whatsapp.net";
   * await ctx.reply(`@${jid.split("@")[0]}, welcome`, { mentions: [jid] });
   *
   * @example
   * // No link preview, no quote:
   * await ctx.reply("https://example.com", { quote: false, linkPreview: false });
   */
  async reply(text: string, opts?: ReplyOpts): Promise<WAMessage> {
    const content: AnyMessageContent = {
      text,
      ...(opts?.mentions ? { mentions: opts.mentions } : {}),
      ...(opts?.linkPreview === false ? { linkPreview: null } : {}),
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send an image reply. The `media` accepts a `Buffer`, a URL string, or
   * `{ url }`.
   *
   * @example
   * import { readFile } from "node:fs/promises";
   * bot.command("logo", async (ctx) => {
   *   const buf = await readFile("./logo.png");
   *   await ctx.replyWithImage(buf, { caption: "here's the logo" });
   * });
   *
   * @example
   * // From URL:
   * await ctx.replyWithImage("https://example.com/cat.jpg");
   */
  async replyWithImage(
    media: MediaInput,
    opts?: {
      caption?: string;
      mentions?: string[];
      quote?: boolean;
    },
  ): Promise<WAMessage> {
    const content: AnyMessageContent = {
      image: toMediaUpload(media),
      ...(opts?.caption !== undefined ? { caption: opts.caption } : {}),
      ...(opts?.mentions ? { mentions: opts.mentions } : {}),
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send a video reply. Set `gifPlayback: true` to make WhatsApp display it
   * as a looping animation (the "GIF" appearance) without sound.
   *
   * @example
   * await ctx.replyWithVideo(buf, { caption: "watch this" });
   *
   * @example
   * await ctx.replyWithVideo(buf, { gifPlayback: true });
   */
  async replyWithVideo(
    media: MediaInput,
    opts?: {
      caption?: string;
      gifPlayback?: boolean;
      mentions?: string[];
      quote?: boolean;
    },
  ): Promise<WAMessage> {
    const content: AnyMessageContent = {
      video: toMediaUpload(media),
      ...(opts?.caption !== undefined ? { caption: opts.caption } : {}),
      ...(opts?.gifPlayback !== undefined
        ? { gifPlayback: opts.gifPlayback }
        : {}),
      ...(opts?.mentions ? { mentions: opts.mentions } : {}),
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send an audio reply. Set `ptt: true` to send it as a voice note (the
   * waveform UI you see when someone records audio directly in the app).
   *
   * When `ptt` is `true` and no explicit `mimetype` is given, defaults to
   * `audio/ogg; codecs=opus` (the codec WhatsApp uses internally for PTT).
   *
   * @example
   * // Normal music file:
   * await ctx.replyWithAudio(buf, { mimetype: "audio/mp4" });
   *
   * @example
   * // Voice note from Opus buffer:
   * await ctx.replyWithAudio(opusBuf, { ptt: true });
   */
  async replyWithAudio(
    media: MediaInput,
    opts?: {
      ptt?: boolean;
      mimetype?: string;
      quote?: boolean;
    },
  ): Promise<WAMessage> {
    const ptt = opts?.ptt === true;
    const mimetype = opts?.mimetype ?? (ptt ? "audio/ogg; codecs=opus" : undefined);
    const content: AnyMessageContent = {
      audio: toMediaUpload(media),
      ...(opts?.ptt !== undefined ? { ptt: opts.ptt } : {}),
      ...(mimetype !== undefined ? { mimetype } : {}),
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send a document reply (any file Baileys can upload). Unlike the other
   * `replyWith*` helpers, `fileName` and `mimetype` are required: WhatsApp
   * uses them for the file's display name and preview icon.
   *
   * @example
   * await ctx.replyWithDocument(pdfBuf, {
   *   fileName: "report.pdf",
   *   mimetype: "application/pdf",
   *   caption: "monthly report",
   * });
   */
  async replyWithDocument(
    media: MediaInput,
    opts: {
      fileName: string;
      mimetype: string;
      caption?: string;
      quote?: boolean;
    },
  ): Promise<WAMessage> {
    const content: AnyMessageContent = {
      document: toMediaUpload(media),
      fileName: opts.fileName,
      mimetype: opts.mimetype,
      ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send a sticker. Stickers are square (typically 512x512) WebP files for
   * static, or WebP-animated for animated ones. Set `animated: true` for
   * animated stickers.
   *
   * @example
   * await ctx.replyWithSticker(webpBuf);
   *
   * @example
   * await ctx.replyWithSticker(animatedBuf, { animated: true });
   */
  async replyWithSticker(
    media: MediaInput,
    opts?: { animated?: boolean; quote?: boolean },
  ): Promise<WAMessage> {
    const content: AnyMessageContent = {
      sticker: toMediaUpload(media),
      ...(opts?.animated !== undefined ? { isAnimated: opts.animated } : {}),
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send a geographical location pin. The optional `name` and `address`
   * appear as a labeled card in the chat.
   *
   * @example
   * await ctx.replyWithLocation(-23.5505, -46.6333, {
   *   name: "São Paulo",
   *   address: "Sé, São Paulo - SP",
   * });
   */
  async replyWithLocation(
    lat: number,
    lon: number,
    opts?: { name?: string; address?: string; quote?: boolean },
  ): Promise<WAMessage> {
    const content: AnyMessageContent = {
      location: {
        degreesLatitude: lat,
        degreesLongitude: lon,
        ...(opts?.name !== undefined ? { name: opts.name } : {}),
        ...(opts?.address !== undefined ? { address: opts.address } : {}),
      },
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send one or more contact cards. Each entry needs a `fullName` (display
   * name) and a `vcard` (raw vCard 3.0 text).
   *
   * When there are multiple contacts, the chat shows "Contacts" as the
   * grouped name; for a single contact, the `fullName` is used.
   *
   * @example
   * await ctx.replyWithContact([{
   *   fullName: "Support",
   *   vcard: "BEGIN:VCARD\nVERSION:3.0\nFN:Support\nTEL;type=CELL;waid=5511999999999:+55 11 99999-9999\nEND:VCARD",
   * }]);
   */
  async replyWithContact(
    contacts: Array<{ fullName: string; vcard: string }>,
    opts?: { quote?: boolean },
  ): Promise<WAMessage> {
    const displayName =
      contacts.length > 1 ? "Contacts" : contacts[0]?.fullName ?? "";
    const content: AnyMessageContent = {
      contacts: {
        displayName,
        contacts: contacts.map((c) => ({ vcard: c.vcard })),
      },
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  /**
   * Send a poll. `name` is the question; `values` are the options. By
   * default voters can pick a single option; pass `selectableCount` to allow
   * multi-select.
   *
   * Vote events arrive as `messages.upsert` containing `pollUpdateMessage`,
   * which our filter exposes as `message:poll:vote`.
   *
   * @example
   * await ctx.replyWithPoll("Pizza?", ["Yes", "No", "Maybe"]);
   *
   * @example
   * // Multi-select up to 2:
   * await ctx.replyWithPoll("Favorite genres?", ["pop", "rock", "jazz", "samba"], {
   *   selectableCount: 2,
   * });
   */
  async replyWithPoll(
    name: string,
    values: string[],
    opts?: { selectableCount?: number; quote?: boolean },
  ): Promise<WAMessage> {
    const content: AnyMessageContent = {
      poll: {
        name,
        values,
        selectableCount: opts?.selectableCount ?? 1,
      },
    };
    return this.api.sendMessage(this.chat, content, this.quoteOpts(opts));
  }

  // ───────────────────────── message actions ─────────────────────────

  /**
   * Decrypts the poll vote wrapped by this context and resolves the selected
   * options to their names. Only meaningful inside a `message:poll:vote`
   * handler.
   *
   * WhatsApp encrypts votes with the `messageSecret` stored inside the poll
   * creation message, so the caller supplies that message: persist the
   * return value of {@link Context.replyWithPoll} for polls the bot sends,
   * or the message received in a `message:poll` handler for polls created
   * by others. {@link Context.pollCreationKey} identifies which stored
   * creation message a vote belongs to.
   *
   * @throws When the update is not a poll vote, or when `creation` is not a
   * poll creation message carrying a `messageSecret`.
   *
   * Note that under `.ignore("message:from_me")` the bot's own poll
   * creations never reach a `message:poll` handler (they come back as
   * echoes and are dropped), which is why the bot's own polls are
   * persisted from the `replyWithPoll` return value.
   *
   * @example
   * bot.command("poll", async (ctx) => {
   *   const poll = await ctx.replyWithPoll("Pizza?", ["yes", "no"]);
   *   await db.set(poll.key.id, JSON.stringify(poll));
   * });
   *
   * bot.on("message:poll", (ctx) => {  // polls created by others
   *   return db.set(ctx.messageId, JSON.stringify(ctx.update.message));
   * });
   *
   * bot.on("message:poll:vote", async (ctx) => {
   *   const creation = JSON.parse(await db.get(ctx.pollCreationKey.id));
   *   const { voter, selectedOptions } = ctx.decryptPollVote(creation);
   *   // selectedOptions: ["rock", "jazz"]; empty when the vote was retracted
   * });
   */
  decryptPollVote(creation: WAMessage): PollVote {
    const msg = this.requireMessage("decryptPollVote");
    return readPollVote({
      vote: msg,
      creation,
      meId: this.me.id,
      meLid: this.me.lid,
    });
  }

  /**
   * React to the current message with an emoji. Passing the empty string
   * removes a previously-set reaction.
   *
   * Throws if the wrapped update is not a message.
   *
   * @example
   * bot.on("message:voice", (ctx) => ctx.react("🎙️"));
   *
   * @example
   * // Remove a reaction:
   * await ctx.react("");
   */
  async react(emoji: string): Promise<void> {
    const msg = this.requireMessage("react");
    await this.api.sendReaction(this.chat, msg.key, emoji);
  }

  /**
   * Edit the current message. Only works for messages the bot itself sent.
   *
   * @throws If the wrapped update is not a message, or if `isFromMe` is false.
   *
   * @example
   * // To edit a message the bot sent from a handler, go through the Api
   * // with the sent message's key:
   * const sent = await ctx.reply("processing…");
   * await ctx.api.editMessage(ctx.chat, sent.key, "done");
   */
  async editMessage(text: string): Promise<void> {
    const msg = this.requireMessage("editMessage");
    if (!this.isFromMe) {
      throw new Error("editMessage: can only edit own messages");
    }
    await this.api.editMessage(this.chat, msg.key, text);
  }

  /**
   * Delete the current message. Defaults to deleting for everyone in the
   * chat. Pass `false` to delete only for the bot (the message is removed
   * from the bot's history but other participants still see it).
   *
   * @example
   * bot.command("oops", (ctx) => ctx.deleteMessage());
   */
  async deleteMessage(forEveryone = true): Promise<void> {
    const msg = this.requireMessage("deleteMessage");
    await this.api.deleteMessage(this.chat, msg.key, forEveryone);
  }

  /**
   * Forward the current message to one or more JIDs. Returns the new
   * messages produced at the destinations, in input order.
   *
   * @example
   * bot.command("share", (ctx) => ctx.forwardTo("group@g.us"));
   *
   * @example
   * await ctx.forwardTo([userA, userB]);
   */
  async forwardTo(jid: string | string[]): Promise<WAMessage[]> {
    const msg = this.requireMessage("forwardTo");
    const targets = Array.isArray(jid) ? jid : [jid];
    const out: WAMessage[] = [];
    for (const target of targets) {
      out.push(await this.api.forwardMessage(target, msg));
    }
    return out;
  }

  /**
   * Download and decrypt the media attached to the current message.
   * Returns a `Buffer` ready to be written to disk or re-uploaded.
   *
   * Throws if there's no media (text-only messages, non-message updates).
   *
   * @example
   * bot.on("message:image", async (ctx) => {
   *   const buf = await ctx.downloadMedia();
   *   await writeFile(`./inbox/${ctx.messageId}.jpg`, buf);
   * });
   */
  async downloadMedia(): Promise<Buffer> {
    const msg = this.requireMessage("downloadMedia");
    return this.api.downloadMedia(msg);
  }

  /**
   * Mark the current message as read (the blue ticks in WhatsApp).
   *
   * @example
   * bot.on("message", async (ctx, next) => {
   *   await ctx.markAsRead();
   *   await next();
   * });
   */
  async markAsRead(): Promise<void> {
    const msg = this.requireMessage("markAsRead");
    await this.api.readMessages([msg.key]);
  }

  /**
   * Send a presence update for {@link chat}. Useful for showing "typing..."
   * while preparing a long reply.
   *
   * @example
   * bot.command("slow", async (ctx) => {
   *   await ctx.sendPresence("composing");
   *   await new Promise(r => setTimeout(r, 3000));
   *   await ctx.reply("ok, took a while");
   * });
   */
  async sendPresence(state: PresenceState): Promise<void> {
    await this.api.sendPresence(state, this.chat);
  }

  /**
   * Subscribe to presence updates for the current chat. Without this,
   * `presence.update` events do NOT fire for arbitrary JIDs (Baileys only
   * streams presence for subscribed contacts).
   *
   * Subscriptions reset on socket reconnect.
   *
   * @example
   * bot.command("watch", async (ctx) => {
   *   await ctx.subscribePresence();
   *   await ctx.reply("watching presence for this chat");
   * });
   *
   * bot.on("presence:typing", (ctx) => {
   *   console.log(`${ctx.chat} is typing`);
   * });
   */
  async subscribePresence(): Promise<void> {
    await this.api.subscribePresence(this.chat);
  }

  /**
   * Fetch the URL of the current chat's profile picture. For DMs, this is
   * the contact's avatar; for groups, the group's icon.
   *
   * Returns `undefined` if no picture is set or the user hides it.
   *
   * `type` defaults to `"image"` (full resolution); pass `"preview"` for the
   * thumbnail.
   *
   * @example
   * const url = await ctx.fetchProfilePictureUrl();
   * if (url) console.log("avatar:", url);
   */
  async fetchProfilePictureUrl(
    type: "image" | "preview" = "image",
  ): Promise<string | undefined> {
    return this.api.fetchProfilePictureUrl(this.chat, type);
  }

  // ───────────────────────── group methods ─────────────────────────

  /**
   * Fetch full metadata for the current group: subject, description,
   * participants, admin list, settings.
   *
   * @throws If the current chat is not a group.
   *
   * @example
   * const meta = await ctx.getGroupMetadata();
   * console.log(`${meta.subject} has ${meta.participants.length} members`);
   */
  async getGroupMetadata(): Promise<GroupMetadata> {
    this.requireGroup("getGroupMetadata");
    return this.api.getGroupMetadata(this.chat);
  }

  /**
   * Add one or more participants to the current group. Bot must be admin.
   *
   * @throws If the current chat is not a group.
   *
   * @example
   * await ctx.addParticipants(["5511999999999@s.whatsapp.net"]);
   */
  async addParticipants(jids: string[]) {
    this.requireGroup("addParticipants");
    return this.api.groupParticipantsUpdate(this.chat, jids, "add");
  }

  /**
   * Remove one or more participants from the current group. Bot must be admin.
   *
   * @throws If the current chat is not a group.
   *
   * @example
   * bot.command("kick", async (ctx) => {
   *   const target = ctx.mentions[0];
   *   if (target) await ctx.removeParticipants([target]);
   * });
   */
  async removeParticipants(jids: string[]) {
    this.requireGroup("removeParticipants");
    return this.api.groupParticipantsUpdate(this.chat, jids, "remove");
  }

  /**
   * Promote participants to admin. Bot must be admin.
   * @throws If the current chat is not a group.
   */
  async promote(jids: string[]) {
    this.requireGroup("promote");
    return this.api.groupParticipantsUpdate(this.chat, jids, "promote");
  }

  /**
   * Demote participants from admin to regular member. Bot must be admin.
   * @throws If the current chat is not a group.
   */
  async demote(jids: string[]) {
    this.requireGroup("demote");
    return this.api.groupParticipantsUpdate(this.chat, jids, "demote");
  }

  /**
   * Change the group subject (visible name). Subject to WhatsApp's
   * server-side length limit. Bot must be admin if the group has
   * "only admins can edit group info" enabled.
   *
   * @throws If the current chat is not a group.
   *
   * @example
   * await ctx.updateGroupSubject("My new group name");
   */
  async updateGroupSubject(text: string): Promise<void> {
    this.requireGroup("updateGroupSubject");
    await this.api.updateGroupSubject(this.chat, text);
  }

  /**
   * Change the group description. Same admin-rights rule as
   * {@link updateGroupSubject}.
   *
   * @throws If the current chat is not a group.
   */
  async updateGroupDescription(text: string): Promise<void> {
    this.requireGroup("updateGroupDescription");
    await this.api.updateGroupDescription(this.chat, text);
  }

  /**
   * Leave the current group. Equivalent to "Exit group" in the app.
   *
   * @throws If the current chat is not a group.
   */
  async leaveGroup(): Promise<void> {
    this.requireGroup("leaveGroup");
    await this.api.leaveGroup(this.chat);
  }
}

// Re-export Baileys' key type so callers don't need a direct Baileys import.
export type { WAMessageKey };
