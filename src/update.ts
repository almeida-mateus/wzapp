/**
 * Unified update contract: a discriminated union covering every Baileys event
 * we care about. Adapters translate raw Baileys event payloads into arrays of
 * `WhatsappUpdate`s so the runner has a single shape to dispatch on.
 */
import type {
  Chat,
  ConnectionState,
  Contact,
  GroupMetadata,
  GroupParticipant,
  MessageUpsertType,
  MessageUserReceiptUpdate,
  ParticipantAction,
  PresenceData,
  WACallEvent,
  WAMessage,
  WAMessageKey,
  WAMessageUpdate,
  proto,
} from "@whiskeysockets/baileys";

// ─── Update union ──────────────────────────────────────────────────────────

export type WhatsappUpdate =
  | { type: "message"; message: WAMessage }
  | { type: "message_edit"; updates: WAMessageUpdate[] }
  | {
      type: "reaction";
      reactions: { key: WAMessageKey; reaction: proto.IReaction }[];
    }
  | { type: "message_delete"; keys: WAMessageKey[] }
  | { type: "message_receipt"; receipts: MessageUserReceiptUpdate[] }
  | { type: "presence"; jid: string; presences: Record<string, PresenceData> }
  | {
      type: "group_metadata";
      subtype: "upsert" | "update";
      groups: GroupMetadata[] | Partial<GroupMetadata>[];
    }
  | {
      type: "group_participants";
      jid: string;
      participants: GroupParticipant[];
      action: "add" | "remove" | "promote" | "demote";
      /**
       * JID of the admin who triggered the action. This and the other
       * `author*` fields are only populated on Baileys v7+.
       */
      author?: string;
      /** Phone-number form of {@link author}. */
      authorPn?: string;
      /** WhatsApp username of {@link author} when set. */
      authorUsername?: string;
    }
  | {
      type: "chat";
      subtype: "upsert" | "update" | "delete";
      chats: Chat[] | Partial<Chat>[] | string[];
    }
  | {
      type: "contact";
      subtype: "upsert" | "update";
      contacts: Contact[] | Partial<Contact>[];
    }
  | { type: "connection"; state: Partial<ConnectionState> }
  | { type: "call"; calls: WACallEvent[] }
  | { type: "blocklist"; action: "add" | "remove"; jids: string[] };

// ─── Adapters ──────────────────────────────────────────────────────────────

/**
 * Returns `true` if the message is purely an internal Baileys protocol
 * envelope (e.g. ack, history sync, app-state notification) and carries
 * nothing else worth dispatching to user middleware.
 */
function isPureProtocolMessage(m: WAMessage): boolean {
  const inner = m.message;
  if (!inner) return false;
  if (!inner.protocolMessage) return false;
  for (const key of Object.keys(inner)) {
    if (key === "protocolMessage") continue;
    const value = (inner as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) return false;
  }
  return true;
}

export function fromMessagesUpsert(payload: {
  messages: WAMessage[];
  type: MessageUpsertType;
}): WhatsappUpdate[] {
  const out: WhatsappUpdate[] = [];
  for (const message of payload.messages) {
    if (!message.message) continue;
    if (isPureProtocolMessage(message)) continue;
    out.push({ type: "message", message });
  }
  return out;
}

export function fromMessagesUpdate(updates: WAMessageUpdate[]): WhatsappUpdate[] {
  return [{ type: "message_edit", updates }];
}

export function fromMessagesReaction(
  reactions: { key: WAMessageKey; reaction: proto.IReaction }[],
): WhatsappUpdate[] {
  return [{ type: "reaction", reactions }];
}

/**
 * Baileys delivers `messages.delete` in one of two shapes:
 *   - `{ keys: WAMessageKey[] }`
 *   - `{ jid: string; all: true }`
 *
 * We only forward the first shape; the "delete all in chat" form has no
 * useful per-message data and is left as a no-op for now.
 */
export function fromMessagesDelete(
  payload: { keys: WAMessageKey[] } | { jid: string; all: true },
): WhatsappUpdate[] {
  if ("keys" in payload) {
    return [{ type: "message_delete", keys: payload.keys }];
  }
  return [];
}

export function fromMessageReceipt(
  receipts: MessageUserReceiptUpdate[],
): WhatsappUpdate[] {
  return [{ type: "message_receipt", receipts }];
}

export function fromPresenceUpdate(payload: {
  id: string;
  presences: Record<string, PresenceData>;
}): WhatsappUpdate[] {
  return [{ type: "presence", jid: payload.id, presences: payload.presences }];
}

export function fromGroupsUpsert(groups: GroupMetadata[]): WhatsappUpdate[] {
  return [{ type: "group_metadata", subtype: "upsert", groups }];
}

export function fromGroupsUpdate(
  groups: Partial<GroupMetadata>[],
): WhatsappUpdate[] {
  return [{ type: "group_metadata", subtype: "update", groups }];
}

/**
 * Baileys' `ParticipantAction` includes a `'modify'` value we don't surface
 * in the unified contract (it's a no-op administrative tweak). We drop it.
 *
 * Payloads may include `author`/`authorPn`/`authorUsername` identifying the
 * admin who performed the action. These are forwarded when present.
 */
export function fromGroupParticipantsUpdate(payload: {
  id: string;
  participants: GroupParticipant[];
  action: ParticipantAction;
  author?: string;
  authorPn?: string;
  authorUsername?: string;
}): WhatsappUpdate[] {
  if (payload.action === "modify") return [];
  return [
    {
      type: "group_participants",
      jid: payload.id,
      participants: payload.participants,
      action: payload.action,
      ...(payload.author !== undefined ? { author: payload.author } : {}),
      ...(payload.authorPn !== undefined ? { authorPn: payload.authorPn } : {}),
      ...(payload.authorUsername !== undefined
        ? { authorUsername: payload.authorUsername }
        : {}),
    },
  ];
}

export function fromChatsUpsert(chats: Chat[]): WhatsappUpdate[] {
  return [{ type: "chat", subtype: "upsert", chats }];
}

export function fromChatsUpdate(chats: Partial<Chat>[]): WhatsappUpdate[] {
  return [{ type: "chat", subtype: "update", chats }];
}

export function fromChatsDelete(ids: string[]): WhatsappUpdate[] {
  return [{ type: "chat", subtype: "delete", chats: ids }];
}

export function fromContactsUpsert(contacts: Contact[]): WhatsappUpdate[] {
  return [{ type: "contact", subtype: "upsert", contacts }];
}

export function fromContactsUpdate(
  contacts: Partial<Contact>[],
): WhatsappUpdate[] {
  return [{ type: "contact", subtype: "update", contacts }];
}

export function fromConnectionUpdate(
  state: Partial<ConnectionState>,
): WhatsappUpdate[] {
  return [{ type: "connection", state }];
}

export function fromCall(calls: WACallEvent[]): WhatsappUpdate[] {
  return [{ type: "call", calls }];
}

export function fromBlocklistUpdate(payload: {
  blocklist: string[];
  type: "add" | "remove";
}): WhatsappUpdate[] {
  return [{ type: "blocklist", action: payload.type, jids: payload.blocklist }];
}
