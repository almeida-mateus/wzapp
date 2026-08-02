/**
 * Filter query DSL. Mirrors grammY's `bot.on("message:text", ...)`
 * ergonomics with WhatsApp-flavoured paths.
 *
 * Syntax rules:
 *
 * - A single string is a fixed path of the form `<type>` or
 *   `<type>:<sub>:<sub>`. There is no per-level combination logic: after
 *   alias resolution, the whole string is looked up as one key in a canonical
 *   predicate table, so only the paths listed in {@link FilterQuery} exist.
 * - An array of strings is OR. This is the ONLY form of OR; you cannot put
 *   `|` inside a single level.
 *
 * Aliases supported at level 0:
 *
 * - `msg` resolves to `message`.
 * - `text` resolves to `message:text` (specific, not broad).
 * - `media` expands to an OR over the media variants
 *   (image, video, audio, voice, document, sticker).
 *
 * @example
 * matchFilter("message:image")(update);           // true if image message
 * matchFilter(["message:image", "message:video"])(update);  // OR
 * matchFilter("group:participants:add")(update);  // someone joined
 */
import {
  getCaption,
  getMentions,
  getQuoted,
  isAnimatedSticker,
  isButtonReply,
  isContactMessage,
  isDocumentMessage,
  isForwarded,
  isGroupInviteMessage,
  isImageMessage,
  isListReply,
  isLiveLocationMessage,
  isLocationMessage,
  isPollMessage,
  isPollVote,
  isReactionMessage,
  isStickerMessage,
  isTextMessage,
  isVideoMessage,
  isVoiceMessage,
  isAudioMessage,
} from "./helpers/message.js";
import {
  isBroadcastJid,
  isGroupJid,
  isPrivateJid,
} from "./helpers/jid.js";
import type { WhatsappUpdate } from "./update.js";
import type { WAMessage, proto } from "@whiskeysockets/baileys";

// ─── Narrowed WAMessage types ──────────────────────────────────────────────
//
// These types refine `WAMessage` so that, after a successful filter match,
// the handler can reach into `update.message.message.<field>` without
// optional chaining. They are the type-level counterpart of the runtime
// predicates in `PREDICATE_TABLE`.

/**
 * A {@link WAMessage} whose inner `.message` is non-null AND has a specific
 * sub-field of {@link proto.IMessage} required and non-null.
 *
 * `K` must be a key of {@link proto.IMessage}. For example,
 * `WAMessageWith<"imageMessage">` is a `WAMessage` whose
 * `.message.imageMessage` is guaranteed to be present.
 */
export type WAMessageWith<K extends keyof proto.IMessage> = WAMessage & {
  message: proto.IMessage & { [P in K]-?: NonNullable<proto.IMessage[P]> };
};

/**
 * A {@link WAMessage} carrying textual content: either `conversation` or
 * `extendedTextMessage.text` is present and non-empty at the type level.
 */
export type TextWAMessage = WAMessage & {
  message: proto.IMessage &
    (
      | { conversation: string }
      | { extendedTextMessage: NonNullable<proto.Message.IExtendedTextMessage> & { text: string } }
    );
};

/**
 * A {@link WAMessage} that is specifically a voice note: it has an
 * `audioMessage` and that `audioMessage.ptt === true`.
 */
export type VoiceWAMessage = WAMessage & {
  message: proto.IMessage & {
    audioMessage: NonNullable<proto.Message.IAudioMessage> & { ptt: true };
  };
};

/** Narrowed sticker variant: animated stickers (`isAnimated: true`). */
export type AnimatedStickerWAMessage = WAMessage & {
  message: proto.IMessage & {
    stickerMessage: NonNullable<proto.Message.IStickerMessage> & { isAnimated: true };
  };
};

/**
 * Narrowed poll variant: one of the poll-creation shapes V1 through V5.
 * `V4` differs from the others: it is a `FutureProofMessage` envelope whose
 * `message` field wraps the actual poll content.
 */
export type PollWAMessage = WAMessage & {
  message: proto.IMessage &
    (
      | { pollCreationMessage: NonNullable<proto.Message.IPollCreationMessage> }
      | { pollCreationMessageV2: NonNullable<proto.Message.IPollCreationMessage> }
      | { pollCreationMessageV3: NonNullable<proto.Message.IPollCreationMessage> }
      | { pollCreationMessageV4: NonNullable<proto.Message.IFutureProofMessage> }
      | { pollCreationMessageV5: NonNullable<proto.Message.IPollCreationMessage> }
    );
};

/** Narrowed button-reply variant: either `buttonsResponse` or `templateButtonReply`. */
export type ButtonReplyWAMessage = WAMessage & {
  message: proto.IMessage &
    (
      | { buttonsResponseMessage: NonNullable<proto.Message.IButtonsResponseMessage> }
      | { templateButtonReplyMessage: NonNullable<proto.Message.ITemplateButtonReplyMessage> }
    );
};

/**
 * Narrowed caption-bearing variant: image, video, or plain document with a
 * caption. The runtime predicate (via `getCaption`) also matches
 * `documentWithCaptionMessage`, but the type deliberately narrows only the
 * three plain variants.
 */
export type CaptionWAMessage = WAMessage & {
  message: proto.IMessage &
    (
      | { imageMessage: NonNullable<proto.Message.IImageMessage> & { caption: string } }
      | { videoMessage: NonNullable<proto.Message.IVideoMessage> & { caption: string } }
      | { documentMessage: NonNullable<proto.Message.IDocumentMessage> & { caption: string } }
    );
};

/** Narrowed `fromMe` variant: `key.fromMe` is the literal `true`. */
export type FromMeWAMessage = WAMessage & {
  key: WAMessage["key"] & { fromMe: true };
};

// ─── Brand-only narrows ────────────────────────────────────────────────────
//
// For queries that don't constrain the inner `message` shape but do imply a
// property invariant (e.g. "the message has a quotedMessage"), we attach a
// nominal brand. The brand property is optional so existing `WAMessage`
// values continue to be assignable; the brand exists purely to let the
// `Context` getter return type ride the narrow.

declare const __brand: unique symbol;
type Brand<B extends string> = { readonly [__brand]?: B };

/** Narrowed: the message has a quoted reply (`contextInfo.quotedMessage`). */
export type QuotedWAMessage = WAMessage & {
  message: NonNullable<WAMessage["message"]>;
} & Brand<"quoted">;

/** Narrowed: the message mentions at least one JID. */
export type MentionWAMessage = WAMessage & {
  message: NonNullable<WAMessage["message"]>;
} & Brand<"mention">;

/** Narrowed: the message is marked as forwarded. */
export type ForwardedWAMessage = WAMessage & {
  message: NonNullable<WAMessage["message"]>;
} & Brand<"forwarded">;

/** Narrowed: the message's chat JID is a one-on-one. */
export type PrivateWAMessage = WAMessage & Brand<"private">;
/** Narrowed: the message's chat JID is a group. */
export type GroupWAMessage = WAMessage & Brand<"group">;
/** Narrowed: the message's chat JID is a broadcast. */
export type BroadcastWAMessage = WAMessage & Brand<"broadcast">;

// ─── FilterQuery union ─────────────────────────────────────────────────────

export type FilterQuery =
  // top-level / message aliases
  | "message"
  | "msg"
  | "text"
  | "media"
  // message:*
  | "message:text"
  | "message:image"
  | "message:video"
  | "message:audio"
  | "message:voice"
  | "message:document"
  | "message:sticker"
  | "message:sticker:animated"
  | "message:contact"
  | "message:location"
  | "message:location:live"
  | "message:reaction"
  | "message:poll"
  | "message:poll:vote"
  | "message:button_reply"
  | "message:list_reply"
  | "message:group_invite"
  | "message:quoted"
  | "message:mention"
  | "message:from_me"
  | "message:forwarded"
  | "message:caption"
  | "message:private"
  | "message:group"
  | "message:broadcast"
  // edits
  | "message_edit"
  // deletions / receipts
  | "message_delete"
  | "message_receipt"
  // reactions
  | "reaction"
  | "reaction:added"
  | "reaction:removed"
  // presence
  | "presence"
  | "presence:typing"
  | "presence:recording"
  | "presence:paused"
  | "presence:available"
  | "presence:unavailable"
  // group metadata
  | "group_metadata"
  | "group_metadata:upsert"
  | "group_metadata:update"
  // group participants
  | "group:participants:add"
  | "group:participants:remove"
  | "group:participants:promote"
  | "group:participants:demote"
  // chat
  | "chat:upsert"
  | "chat:update"
  | "chat:delete"
  // contact
  | "contact:upsert"
  | "contact:update"
  // connection
  | "connection"
  | "connection:open"
  | "connection:close"
  | "connection:connecting"
  | "connection:qr"
  | "connection:pairing_code"
  // call
  | "call"
  | "call:offer"
  | "call:accept"
  | "call:reject"
  | "call:timeout"
  // blocklist
  | "blocklist"
  | "blocklist:add"
  | "blocklist:remove";

// ─── Narrowing types ───────────────────────────────────────────────────────

/**
 * Resolves a level-0 string to the discriminant of `WhatsappUpdate`. Aliases:
 *   - `msg | text | media` → `message`
 *   - `group` → `group_participants` (only used in `group:participants:*`)
 *
 * Anything not matching a known alias or a real discriminant resolves to
 * `never`, which falls out of `Extract<...>` and yields `never`.
 */
export type ResolveAlias<S extends string> = S extends "msg"
  ? "message"
  : S extends "text"
    ? "message"
    : S extends "media"
      ? "message"
      : S extends "group"
        ? "group_participants"
        : S extends WhatsappUpdate["type"]
          ? S
          : never;

// Maps each filter query string to the narrowed message variant.
// Queries not listed here fall through to the generic `Extract` below.
type QueryToMessage<Q extends string> = Q extends "message:text" | "text"
  ? TextWAMessage
  : Q extends "message:image"
    ? WAMessageWith<"imageMessage">
    : Q extends "message:video"
      ? WAMessageWith<"videoMessage">
      : Q extends "message:audio"
        ? WAMessageWith<"audioMessage">
        : Q extends "message:voice"
          ? VoiceWAMessage
          : Q extends "message:document"
            ? WAMessageWith<"documentMessage">
            : Q extends "message:sticker"
              ? WAMessageWith<"stickerMessage">
              : Q extends "message:sticker:animated"
                ? AnimatedStickerWAMessage
                : Q extends "message:contact"
                  ? WAMessageWith<"contactMessage">
                  : Q extends "message:location"
                    ? WAMessageWith<"locationMessage">
                    : Q extends "message:location:live"
                      ? WAMessageWith<"liveLocationMessage">
                      : Q extends "message:reaction"
                        ? WAMessageWith<"reactionMessage">
                        : Q extends "message:poll"
                          ? PollWAMessage
                          : Q extends "message:poll:vote"
                            ? WAMessageWith<"pollUpdateMessage">
                            : Q extends "message:button_reply"
                              ? ButtonReplyWAMessage
                              : Q extends "message:list_reply"
                                ? WAMessageWith<"listResponseMessage">
                                : Q extends "message:group_invite"
                                  ? WAMessageWith<"groupInviteMessage">
                                  : Q extends "message:quoted"
                                    ? QuotedWAMessage
                                    : Q extends "message:mention"
                                      ? MentionWAMessage
                                      : Q extends "message:from_me"
                                        ? FromMeWAMessage
                                        : Q extends "message:forwarded"
                                          ? ForwardedWAMessage
                                          : Q extends "message:caption"
                                            ? CaptionWAMessage
                                            : Q extends "message:private"
                                              ? PrivateWAMessage
                                              : Q extends "message:group"
                                                ? GroupWAMessage
                                                : Q extends "message:broadcast"
                                                  ? BroadcastWAMessage
                                                  : never;

type CoreOf<Q extends string> = QueryToMessage<Q> extends never
  ? Q extends `${infer L0}:${string}`
    ? Extract<WhatsappUpdate, { type: ResolveAlias<L0> }>
    : Extract<WhatsappUpdate, { type: ResolveAlias<Q> }>
  : { type: "message"; message: QueryToMessage<Q> };

export type FilterCore<Q extends FilterQuery | readonly FilterQuery[]> =
  Q extends readonly (infer E)[]
    ? E extends FilterQuery
      ? CoreOf<E>
      : never
    : Q extends FilterQuery
      ? CoreOf<Q>
      : never;

// ─── Runtime: predicates ───────────────────────────────────────────────────

type Predicate = (u: WhatsappUpdate) => boolean;

/**
 * The runtime alias map for level-0 strings. Keys here override the type
 * discriminant; values are the canonical `update.type` they imply.
 *
 * `media` and bare `text` are special: both are short-circuited by
 * `compileSingle` before this map is consulted. `media` expands to an OR of
 * the media message predicates, and `text` resolves straight to the
 * `message:text` predicate.
 */
const TYPE_ALIAS: Record<string, WhatsappUpdate["type"]> = {
  msg: "message",
  message: "message",
  text: "message",
  message_edit: "message_edit",
  reaction: "reaction",
  message_delete: "message_delete",
  message_receipt: "message_receipt",
  presence: "presence",
  group_metadata: "group_metadata",
  // `group:participants:*`: level 0 is `group`, resolves to group_participants
  group: "group_participants",
  chat: "chat",
  contact: "contact",
  connection: "connection",
  call: "call",
  blocklist: "blocklist",
};

// Type guard wrappers narrowing to the specific update variant.
type MessageUpdate = Extract<WhatsappUpdate, { type: "message" }>;
type ReactionUpdate = Extract<WhatsappUpdate, { type: "reaction" }>;
type PresenceUpdate = Extract<WhatsappUpdate, { type: "presence" }>;
type GroupMetadataUpdate = Extract<WhatsappUpdate, { type: "group_metadata" }>;
type GroupParticipantsUpdate = Extract<
  WhatsappUpdate,
  { type: "group_participants" }
>;
type ChatUpdate = Extract<WhatsappUpdate, { type: "chat" }>;
type ContactUpdate = Extract<WhatsappUpdate, { type: "contact" }>;
type ConnectionUpdate = Extract<WhatsappUpdate, { type: "connection" }>;
type CallUpdate = Extract<WhatsappUpdate, { type: "call" }>;
type BlocklistUpdate = Extract<WhatsappUpdate, { type: "blocklist" }>;

function ifMessage(pred: (u: MessageUpdate) => boolean): Predicate {
  return (u) => u.type === "message" && pred(u);
}
function ifReaction(pred: (u: ReactionUpdate) => boolean): Predicate {
  return (u) => u.type === "reaction" && pred(u);
}
function ifPresence(pred: (u: PresenceUpdate) => boolean): Predicate {
  return (u) => u.type === "presence" && pred(u);
}
function ifGroupMetadata(
  pred: (u: GroupMetadataUpdate) => boolean,
): Predicate {
  return (u) => u.type === "group_metadata" && pred(u);
}
function ifGroupParticipants(
  pred: (u: GroupParticipantsUpdate) => boolean,
): Predicate {
  return (u) => u.type === "group_participants" && pred(u);
}
function ifChat(pred: (u: ChatUpdate) => boolean): Predicate {
  return (u) => u.type === "chat" && pred(u);
}
function ifContact(pred: (u: ContactUpdate) => boolean): Predicate {
  return (u) => u.type === "contact" && pred(u);
}
function ifConnection(pred: (u: ConnectionUpdate) => boolean): Predicate {
  return (u) => u.type === "connection" && pred(u);
}
function ifCall(pred: (u: CallUpdate) => boolean): Predicate {
  return (u) => u.type === "call" && pred(u);
}
function ifBlocklist(pred: (u: BlocklistUpdate) => boolean): Predicate {
  return (u) => u.type === "blocklist" && pred(u);
}

/**
 * Canonical predicate table, keyed by *resolved* path (after applying the
 * level-0 alias map). The matcher computes the canonical path and looks
 * directly into this table.
 */
const PREDICATE_TABLE: Record<string, Predicate> = {
  // ── bare type matches ───────────────────────────────────────────────
  message: (u) => u.type === "message",
  message_edit: (u) => u.type === "message_edit",
  message_delete: (u) => u.type === "message_delete",
  message_receipt: (u) => u.type === "message_receipt",
  reaction: (u) => u.type === "reaction",
  presence: (u) => u.type === "presence",
  group_metadata: (u) => u.type === "group_metadata",
  group_participants: (u) => u.type === "group_participants",
  chat: (u) => u.type === "chat",
  contact: (u) => u.type === "contact",
  connection: (u) => u.type === "connection",
  call: (u) => u.type === "call",
  blocklist: (u) => u.type === "blocklist",

  // ── message:* ───────────────────────────────────────────────────────
  "message:text": ifMessage((u) => isTextMessage(u.message)),
  "message:image": ifMessage((u) => isImageMessage(u.message)),
  "message:video": ifMessage((u) => isVideoMessage(u.message)),
  "message:audio": ifMessage((u) => isAudioMessage(u.message)),
  "message:voice": ifMessage((u) => isVoiceMessage(u.message)),
  "message:document": ifMessage((u) => isDocumentMessage(u.message)),
  "message:sticker": ifMessage((u) => isStickerMessage(u.message)),
  "message:sticker:animated": ifMessage(
    (u) => isStickerMessage(u.message) && isAnimatedSticker(u.message),
  ),
  "message:contact": ifMessage((u) => isContactMessage(u.message)),
  "message:location": ifMessage((u) => isLocationMessage(u.message)),
  "message:location:live": ifMessage((u) => isLiveLocationMessage(u.message)),
  "message:reaction": ifMessage((u) => isReactionMessage(u.message)),
  "message:poll": ifMessage((u) => isPollMessage(u.message)),
  "message:poll:vote": ifMessage((u) => isPollVote(u.message)),
  "message:button_reply": ifMessage((u) => isButtonReply(u.message)),
  "message:list_reply": ifMessage((u) => isListReply(u.message)),
  "message:group_invite": ifMessage((u) => isGroupInviteMessage(u.message)),
  "message:quoted": ifMessage((u) => getQuoted(u.message) !== undefined),
  "message:mention": ifMessage((u) => getMentions(u.message).length > 0),
  "message:from_me": ifMessage((u) => u.message.key.fromMe === true),
  "message:forwarded": ifMessage((u) => isForwarded(u.message)),
  "message:caption": ifMessage((u) => {
    const c = getCaption(u.message);
    return typeof c === "string" && c.length > 0;
  }),
  "message:private": ifMessage((u) => isPrivateJid(u.message.key.remoteJid)),
  "message:group": ifMessage((u) => isGroupJid(u.message.key.remoteJid)),
  "message:broadcast": ifMessage((u) =>
    isBroadcastJid(u.message.key.remoteJid),
  ),

  // ── reaction:* ──────────────────────────────────────────────────────
  "reaction:added": ifReaction((u) =>
    u.reactions.some(
      (r) => typeof r.reaction.text === "string" && r.reaction.text.length > 0,
    ),
  ),
  "reaction:removed": ifReaction((u) =>
    u.reactions.some(
      (r) =>
        typeof r.reaction.text !== "string" || r.reaction.text.length === 0,
    ),
  ),

  // ── presence:* ──────────────────────────────────────────────────────
  "presence:typing": ifPresence((u) =>
    Object.values(u.presences).some((p) => p.lastKnownPresence === "composing"),
  ),
  "presence:recording": ifPresence((u) =>
    Object.values(u.presences).some((p) => p.lastKnownPresence === "recording"),
  ),
  "presence:paused": ifPresence((u) =>
    Object.values(u.presences).some((p) => p.lastKnownPresence === "paused"),
  ),
  "presence:available": ifPresence((u) =>
    Object.values(u.presences).some(
      (p) => p.lastKnownPresence === "available",
    ),
  ),
  "presence:unavailable": ifPresence((u) =>
    Object.values(u.presences).some(
      (p) => p.lastKnownPresence === "unavailable",
    ),
  ),

  // ── group_metadata:* ────────────────────────────────────────────────
  "group_metadata:upsert": ifGroupMetadata((u) => u.subtype === "upsert"),
  "group_metadata:update": ifGroupMetadata((u) => u.subtype === "update"),

  // ── group_participants:* (alias `group:participants:*`) ─────────────
  "group_participants:participants:add": ifGroupParticipants(
    (u) => u.action === "add",
  ),
  "group_participants:participants:remove": ifGroupParticipants(
    (u) => u.action === "remove",
  ),
  "group_participants:participants:promote": ifGroupParticipants(
    (u) => u.action === "promote",
  ),
  "group_participants:participants:demote": ifGroupParticipants(
    (u) => u.action === "demote",
  ),

  // ── chat:* ──────────────────────────────────────────────────────────
  "chat:upsert": ifChat((u) => u.subtype === "upsert"),
  "chat:update": ifChat((u) => u.subtype === "update"),
  "chat:delete": ifChat((u) => u.subtype === "delete"),

  // ── contact:* ───────────────────────────────────────────────────────
  "contact:upsert": ifContact((u) => u.subtype === "upsert"),
  "contact:update": ifContact((u) => u.subtype === "update"),

  // ── connection:* ────────────────────────────────────────────────────
  "connection:open": ifConnection((u) => u.state.connection === "open"),
  "connection:close": ifConnection((u) => u.state.connection === "close"),
  "connection:connecting": ifConnection(
    (u) => u.state.connection === "connecting",
  ),
  "connection:qr": ifConnection(
    (u) => typeof u.state.qr === "string" && u.state.qr.length > 0,
  ),
  // best-effort: Baileys does not expose a dedicated pairing-code field; we
  // approximate by matching the `connecting` state without a QR string set.
  "connection:pairing_code": ifConnection(
    (u) =>
      u.state.connection === "connecting" &&
      (typeof u.state.qr !== "string" || u.state.qr.length === 0),
  ),

  // ── call:* ──────────────────────────────────────────────────────────
  "call:offer": ifCall((u) => u.calls.some((c) => c.status === "offer")),
  "call:accept": ifCall((u) => u.calls.some((c) => c.status === "accept")),
  "call:reject": ifCall((u) => u.calls.some((c) => c.status === "reject")),
  "call:timeout": ifCall((u) => u.calls.some((c) => c.status === "timeout")),

  // ── blocklist:* ─────────────────────────────────────────────────────
  "blocklist:add": ifBlocklist((u) => u.action === "add"),
  "blocklist:remove": ifBlocklist((u) => u.action === "remove"),
};

// `media` shortcut: image|video|audio|voice|document|sticker.
const MEDIA_MESSAGE_KEYS = [
  "message:image",
  "message:video",
  "message:audio",
  "message:voice",
  "message:document",
  "message:sticker",
] as const;

// ─── Compilation ───────────────────────────────────────────────────────────

/**
 * Compiles a single query string into a predicate. Handles aliases and
 * resolves to the canonical path used as a key in `PREDICATE_TABLE`.
 */
function compileSingle(query: string): Predicate {
  // `text` is an alias for `message:text`.
  if (query === "text") {
    const pred = PREDICATE_TABLE["message:text"];
    if (!pred) throw new Error(`wzapp: predicate missing for "message:text"`);
    return pred;
  }
  // `media` is OR across the media message variants.
  if (query === "media") {
    const preds: Predicate[] = [];
    for (const key of MEDIA_MESSAGE_KEYS) {
      const p = PREDICATE_TABLE[key];
      if (!p) throw new Error(`wzapp: predicate missing for "${key}"`);
      preds.push(p);
    }
    return (u) => preds.some((p) => p(u));
  }

  const levels = query.split(":");
  const head = levels[0];
  if (head === undefined || head.length === 0) {
    throw new Error(`wzapp: invalid filter query "${query}"`);
  }
  const canonicalHead = TYPE_ALIAS[head];
  if (canonicalHead === undefined) {
    throw new Error(`wzapp: unknown filter query head "${head}"`);
  }

  // Build canonical path: replace level 0 with the canonical type, keep rest.
  const canonical =
    levels.length === 1
      ? canonicalHead
      : [canonicalHead, ...levels.slice(1)].join(":");

  const pred = PREDICATE_TABLE[canonical];
  if (!pred) {
    throw new Error(`wzapp: unknown filter query "${query}"`);
  }
  return pred;
}

const CACHE = new Map<string, Predicate>();

function getCompiled(query: string): Predicate {
  const cached = CACHE.get(query);
  if (cached) return cached;
  const compiled = compileSingle(query);
  CACHE.set(query, compiled);
  return compiled;
}

/**
 * Compile a filter query (or OR-array of queries) into a predicate over
 * {@link WhatsappUpdate}. For the string form, predicates are cached per
 * query string, so repeated `matchFilter("X")` calls reuse the same function
 * instance. The array form reuses the cached per-query predicates but builds
 * a fresh OR closure on every call.
 *
 * Used internally by {@link Composer.on} and {@link Composer.ignore}. You can
 * also call it directly when you need ad-hoc filtering outside the
 * middleware system (e.g., inside a `.use` to decide between branches).
 *
 * @throws Synchronously if `query` is not a known {@link FilterQuery}.
 *
 * @example
 * const isImage = matchFilter("message:image");
 * if (isImage(update)) {
 *   // ...
 * }
 *
 * @example
 * // Array OR:
 * const isMedia = matchFilter(["message:image", "message:video"]);
 */
export function matchFilter<Q extends FilterQuery>(
  query: Q | readonly Q[],
): (u: WhatsappUpdate) => boolean {
  if (typeof query === "string") {
    return getCompiled(query);
  }
  const compiled = query.map((q) => getCompiled(q));
  return (u) => compiled.some((p) => p(u));
}
