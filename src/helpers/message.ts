import type { proto, WAMessage } from "@whiskeysockets/baileys";

/**
 * Extracts the *spoken* text of a message, i.e. the user-typed body for
 * `conversation` and `extendedTextMessage` only. Captions are NOT included
 * here; use {@link getCaption} for those.
 */
export function getText(m: WAMessage): string | undefined {
  const inner = m.message;
  if (!inner) return undefined;
  if (typeof inner.conversation === "string" && inner.conversation.length > 0) {
    return inner.conversation;
  }
  if (
    typeof inner.extendedTextMessage?.text === "string" &&
    inner.extendedTextMessage.text.length > 0
  ) {
    return inner.extendedTextMessage.text;
  }
  return undefined;
}

/**
 * Extracts the caption attached to a media message (image, video, document).
 */
export function getCaption(m: WAMessage): string | undefined {
  const inner = m.message;
  if (!inner) return undefined;
  return (
    inner.imageMessage?.caption ??
    inner.videoMessage?.caption ??
    inner.documentMessage?.caption ??
    inner.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    undefined
  );
}

/**
 * Returns the combined effective text of a message: `getText() ?? getCaption()`.
 * This is what `.hears`/`.command` match against.
 */
export function getEffectiveText(m: WAMessage): string | undefined {
  return getText(m) ?? getCaption(m);
}

export interface QuotedMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id: string;
    participant?: string;
  };
  message: proto.IMessage;
  participant?: string;
}

function getContextInfo(m: WAMessage): proto.IContextInfo | undefined {
  const inner = m.message;
  if (!inner) return undefined;
  return (
    inner.extendedTextMessage?.contextInfo ??
    inner.imageMessage?.contextInfo ??
    inner.videoMessage?.contextInfo ??
    inner.audioMessage?.contextInfo ??
    inner.documentMessage?.contextInfo ??
    inner.stickerMessage?.contextInfo ??
    inner.contactMessage?.contextInfo ??
    inner.locationMessage?.contextInfo ??
    inner.liveLocationMessage?.contextInfo ??
    undefined
  );
}

/**
 * Returns the quoted message wrapper, or `undefined` if the message is not a
 * reply or its `contextInfo` carries no `stanzaId`. The returned `key.fromMe`
 * is always `false`, even when the quoted message was sent by the bot.
 */
export function getQuoted(m: WAMessage): QuotedMessage | undefined {
  const ctxInfo = getContextInfo(m);
  if (!ctxInfo?.quotedMessage || !ctxInfo.stanzaId) return undefined;
  const participant = ctxInfo.participant ?? undefined;
  return {
    key: {
      remoteJid: m.key.remoteJid ?? "",
      fromMe: false,
      id: ctxInfo.stanzaId,
      ...(participant !== undefined ? { participant } : {}),
    },
    message: ctxInfo.quotedMessage,
    ...(participant !== undefined ? { participant } : {}),
  };
}

export function getMentions(m: WAMessage): string[] {
  const ctxInfo = getContextInfo(m);
  return ctxInfo?.mentionedJid ?? [];
}

export function isForwarded(m: WAMessage): boolean {
  const ctxInfo = getContextInfo(m);
  if (!ctxInfo) return false;
  if ((ctxInfo.forwardingScore ?? 0) > 0) return true;
  return ctxInfo.isForwarded === true;
}

export type MessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "voice"
  | "document"
  | "sticker"
  | "contact"
  | "location"
  | "live_location"
  | "reaction"
  | "poll"
  | "poll_vote"
  | "button_reply"
  | "list_reply"
  | "group_invite"
  | "unknown";

export function getMessageType(m: WAMessage): MessageType {
  const inner = m.message;
  if (!inner) return "unknown";
  if (
    (typeof inner.conversation === "string" && inner.conversation.length > 0) ||
    (typeof inner.extendedTextMessage?.text === "string" &&
      inner.extendedTextMessage.text.length > 0)
  ) {
    return "text";
  }
  if (inner.imageMessage) return "image";
  if (inner.videoMessage) return "video";
  if (inner.audioMessage) return inner.audioMessage.ptt ? "voice" : "audio";
  if (inner.documentMessage || inner.documentWithCaptionMessage) return "document";
  if (inner.stickerMessage) return "sticker";
  if (inner.contactMessage || inner.contactsArrayMessage) return "contact";
  if (inner.locationMessage) return "location";
  if (inner.liveLocationMessage) return "live_location";
  if (inner.reactionMessage) return "reaction";
  if (inner.pollCreationMessage || inner.pollCreationMessageV2 || inner.pollCreationMessageV3) {
    return "poll";
  }
  if (inner.pollUpdateMessage) return "poll_vote";
  if (inner.buttonsResponseMessage || inner.templateButtonReplyMessage) {
    return "button_reply";
  }
  if (inner.listResponseMessage) return "list_reply";
  if (inner.groupInviteMessage) return "group_invite";
  return "unknown";
}

// ─── Boolean predicates over WAMessage.message (type narrowing lives in filter.ts) ───

export function isTextMessage(m: WAMessage): boolean {
  const inner = m.message;
  if (!inner) return false;
  return (
    (typeof inner.conversation === "string" && inner.conversation.length > 0) ||
    (typeof inner.extendedTextMessage?.text === "string" &&
      inner.extendedTextMessage.text.length > 0)
  );
}

export function isImageMessage(m: WAMessage): boolean {
  return !!m.message?.imageMessage;
}

export function isVideoMessage(m: WAMessage): boolean {
  return !!m.message?.videoMessage;
}

export function isAudioMessage(m: WAMessage): boolean {
  return !!m.message?.audioMessage;
}

export function isVoiceMessage(m: WAMessage): boolean {
  return m.message?.audioMessage?.ptt === true;
}

export function isDocumentMessage(m: WAMessage): boolean {
  return !!(m.message?.documentMessage || m.message?.documentWithCaptionMessage);
}

export function isStickerMessage(m: WAMessage): boolean {
  return !!m.message?.stickerMessage;
}

export function isAnimatedSticker(m: WAMessage): boolean {
  return m.message?.stickerMessage?.isAnimated === true;
}

export function isContactMessage(m: WAMessage): boolean {
  return !!(m.message?.contactMessage || m.message?.contactsArrayMessage);
}

export function isLocationMessage(m: WAMessage): boolean {
  return !!m.message?.locationMessage;
}

export function isLiveLocationMessage(m: WAMessage): boolean {
  return !!m.message?.liveLocationMessage;
}

export function isReactionMessage(m: WAMessage): boolean {
  return !!m.message?.reactionMessage;
}

export function isPollMessage(m: WAMessage): boolean {
  return !!(
    m.message?.pollCreationMessage ||
    m.message?.pollCreationMessageV2 ||
    m.message?.pollCreationMessageV3
  );
}

export function isPollVote(m: WAMessage): boolean {
  return !!m.message?.pollUpdateMessage;
}

export function isButtonReply(m: WAMessage): boolean {
  return !!(m.message?.buttonsResponseMessage || m.message?.templateButtonReplyMessage);
}

export function isListReply(m: WAMessage): boolean {
  return !!m.message?.listResponseMessage;
}

export function isGroupInviteMessage(m: WAMessage): boolean {
  return !!m.message?.groupInviteMessage;
}
