// ─── Core ────────────────────────────────────────────────────────────────

export { Bot } from "./bot.js";
export type {
  AuthHandle,
  BotOptions,
  BrowserDescription,
  StartOptions,
} from "./bot.js";

export { Composer } from "./composer.js";
export type { IgnorableQuery } from "./composer.js";
export { Context } from "./context.js";
export type {
  ContextConstructorOpts,
  MediaInput,
  PresenceState,
  ReplyOpts,
} from "./context.js";

export { Api } from "./api.js";

export { memoryAuthStorage, storageAuthState } from "./auth.js";
export type { AuthStorage, StorageAuthOptions } from "./auth.js";

export { Runner } from "./runner.js";
export type { RunnerOptions } from "./runner.js";

export {
  BotError,
} from "./types.js";
export type {
  ErrorHandler,
  MaybePromise,
  Middleware,
  MiddlewareFn,
  MiddlewareObj,
  NextFn,
} from "./types.js";

// ─── Filter DSL ──

export { matchFilter } from "./filter.js";
export type {
  AnimatedStickerWAMessage,
  BroadcastWAMessage,
  ButtonReplyWAMessage,
  CaptionWAMessage,
  FilterCore,
  FilterQuery,
  ForwardedWAMessage,
  FromMeWAMessage,
  GroupWAMessage,
  MentionWAMessage,
  PollWAMessage,
  PrivateWAMessage,
  QuotedWAMessage,
  TextWAMessage,
  VoiceWAMessage,
  WAMessageWith,
} from "./filter.js";

// ─── Update contract & adapters ──

export type { WhatsappUpdate } from "./update.js";
export {
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

// ─── Helpers ──

export {
  getCaption,
  getEffectiveText,
  getMentions,
  getMessageType,
  getQuoted,
  getText,
  isAnimatedSticker,
  isAudioMessage,
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
} from "./helpers/message.js";
export type { MessageType, QuotedMessage } from "./helpers/message.js";

export {
  extractJid,
  isBroadcastJid,
  isGroupJid,
  isNewsletterJid,
  isPrivateJid,
  isStatusBroadcast,
} from "./helpers/jid.js";
