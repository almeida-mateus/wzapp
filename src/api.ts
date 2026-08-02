import type {
  AnyMessageContent,
  GroupMetadata,
  MiscMessageGenerationOptions,
  ParticipantAction,
  WAMessage,
  WAMessageKey,
  WAPresence,
  WASocket,
} from "@whiskeysockets/baileys";

/**
 * Façade over Baileys' `WASocket`. Exposes a stable, ergonomic surface for
 * the methods bots use most often, so higher-level code like {@link Context}
 * does not depend on the socket's internal shape directly.
 *
 * Available as `ctx.api` inside any middleware. For anything not covered
 * here, use {@link Api.raw} (or `ctx.sock`) as an escape hatch and call
 * Baileys' socket methods directly.
 *
 * @example
 * // Send a message outside the message-handler context (e.g., a cron):
 * await bot.start();
 * // ...later:
 * await bot.api.sendMessage("5511999999999@s.whatsapp.net", { text: "hi" });
 */
export class Api {
  constructor(private readonly sock: WASocket) {}

  /**
   * Direct access to the underlying Baileys `WASocket`. Use this for any
   * operation not wrapped by `Api` (group creation, profile updates,
   * blocklist management, low-level relay, etc).
   *
   * @example
   * await ctx.api.raw.groupCreate("My group", [memberJid]);
   * await ctx.api.raw.updateProfileStatus("new status");
   */
  get raw(): WASocket {
    return this.sock;
  }

  /**
   * Send a message to any JID. This is the low-level building block behind
   * every `ctx.reply*` helper. Prefer the helpers for common cases; reach
   * for this when you need exotic content (forwarding raw messages,
   * disappearing messages, etc.).
   *
   * @throws If Baileys returns `undefined` (rare, usually a connection
   * problem).
   *
   * @example
   * await api.sendMessage("5511999999999@s.whatsapp.net", { text: "hi" });
   *
   * @example
   * // With reply quoting:
   * await api.sendMessage(jid, { text: "answer" }, { quoted: originalMessage });
   */
  async sendMessage(
    jid: string,
    content: AnyMessageContent,
    opts?: MiscMessageGenerationOptions,
  ): Promise<WAMessage> {
    const result = await this.sock.sendMessage(jid, content, opts);
    if (!result) throw new Error(`sendMessage to ${jid} returned no result`);
    return result;
  }

  /**
   * Send a reaction (emoji) to a specific message. Passing the empty string
   * removes the reaction.
   *
   * @example
   * await api.sendReaction(jid, msgKey, "👍");
   * await api.sendReaction(jid, msgKey, "");  // remove
   */
  async sendReaction(
    jid: string,
    key: WAMessageKey,
    emoji: string,
  ): Promise<void> {
    await this.sock.sendMessage(jid, { react: { text: emoji, key } });
  }

  /**
   * Send a presence update. Without a `jid`, sends the bot's global presence
   * (online/offline). With a `jid`, sends scoped presence (typing,
   * recording) to a specific chat.
   *
   * @example
   * await api.sendPresence("available");  // mark bot online globally
   * await api.sendPresence("composing", chatJid);  // show "typing"
   */
  async sendPresence(state: WAPresence, jid?: string): Promise<void> {
    await this.sock.sendPresenceUpdate(state, jid);
  }

  /**
   * Mark messages as read (the blue ticks). Pass message keys obtained from
   * incoming messages.
   *
   * @example
   * await api.readMessages([msg.key]);
   */
  async readMessages(keys: WAMessageKey[]): Promise<void> {
    await this.sock.readMessages(keys);
  }

  /**
   * Edit a previously-sent message. WhatsApp only allows editing messages
   * the current device sent within a short window (around 15 minutes).
   *
   * @throws If Baileys returns `undefined` (edit window expired, message
   * not editable, etc).
   *
   * @example
   * const sent = await api.sendMessage(jid, { text: "loading..." });
   * await api.editMessage(jid, sent.key, "done");
   */
  async editMessage(
    jid: string,
    key: WAMessageKey,
    text: string,
  ): Promise<WAMessage> {
    const result = await this.sock.sendMessage(jid, { text, edit: key });
    if (!result) throw new Error(`editMessage to ${jid} returned no result`);
    return result;
  }

  /**
   * Delete a message. By default deletes for everyone in the chat (the
   * "delete for everyone" option in WhatsApp); pass `false` to delete only
   * for the bot (chat-modify, "delete for me").
   *
   * @example
   * await api.deleteMessage(jid, msg.key);          // for everyone
   * await api.deleteMessage(jid, msg.key, false);   // for bot only
   */
  async deleteMessage(
    jid: string,
    key: WAMessageKey,
    forEveryone = true,
  ): Promise<void> {
    if (forEveryone) {
      await this.sock.sendMessage(jid, { delete: key });
    } else {
      await this.sock.chatModify(
        {
          deleteForMe: {
            deleteMedia: false,
            key,
            timestamp: Date.now(),
          },
        },
        jid,
      );
    }
  }

  /**
   * Forward a message to another JID. The recipient sees it as a forwarded
   * message, with the "Forwarded" tag.
   *
   * @example
   * await api.forwardMessage(otherJid, originalMessage);
   */
  async forwardMessage(toJid: string, message: WAMessage): Promise<WAMessage> {
    const result = await this.sock.sendMessage(toJid, { forward: message });
    if (!result) throw new Error(`forwardMessage to ${toJid} returned no result`);
    return result;
  }

  /**
   * Fetch metadata for a group: subject, description, owner, participants,
   * admin list, settings.
   *
   * @example
   * const meta = await api.getGroupMetadata("group@g.us");
   * console.log(meta.subject, meta.participants.length);
   */
  async getGroupMetadata(jid: string): Promise<GroupMetadata> {
    return this.sock.groupMetadata(jid);
  }

  /**
   * Change the membership state of one or more participants in a group.
   * The bot must be a group admin.
   *
   * `action` is one of:
   * - `"add"`: invite participants.
   * - `"remove"`: remove (kick) participants.
   * - `"promote"`: make participants admins.
   * - `"demote"`: revoke admin from participants.
   *
   * @example
   * await api.groupParticipantsUpdate(groupJid, [userJid], "remove");
   */
  async groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: ParticipantAction,
  ) {
    return this.sock.groupParticipantsUpdate(jid, participants, action);
  }

  /** Change the group subject (visible name). The bot must be admin. */
  async updateGroupSubject(jid: string, subject: string): Promise<void> {
    await this.sock.groupUpdateSubject(jid, subject);
  }

  /** Change the group description. The bot must be admin. */
  async updateGroupDescription(jid: string, description: string): Promise<void> {
    await this.sock.groupUpdateDescription(jid, description);
  }

  /** Leave a group. Equivalent to "Exit group" in the app. */
  async leaveGroup(jid: string): Promise<void> {
    await this.sock.groupLeave(jid);
  }

  /**
   * Download and decrypt the media payload of a message. Returns the raw
   * bytes ready for disk or re-upload.
   *
   * Works for `imageMessage`, `videoMessage`, `audioMessage`,
   * `documentMessage`, and `stickerMessage`.
   *
   * @example
   * import { writeFile } from "node:fs/promises";
   * bot.on("message:image", async (ctx) => {
   *   const buf = await ctx.api.downloadMedia(ctx.update.message);
   *   await writeFile(`./inbox/${ctx.messageId}.jpg`, buf);
   * });
   */
  async downloadMedia(message: WAMessage): Promise<Buffer> {
    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
    return downloadMediaMessage(message, "buffer", {});
  }

  /**
   * Check whether one or more phone numbers have a WhatsApp account. Accepts
   * JIDs (`5511999999999@s.whatsapp.net`) or bare digit-only numbers (Baileys
   * normalizes both forms).
   *
   * Returns one entry per number the server answered for; unregistered
   * numbers may be omitted. `exists: true` means the number is on WhatsApp.
   * Returns an empty array if Baileys could not answer (rare, usually a
   * connectivity issue).
   *
   * @example
   * const [info] = await api.onWhatsApp("5511999999999");
   * if (info?.exists) await api.sendMessage(info.jid, { text: "hi" });
   *
   * @example
   * // Batch check:
   * const results = await api.onWhatsApp("5511...", "5521...", "5531...");
   * const onWa = results.filter((r) => r.exists).map((r) => r.jid);
   */
  async onWhatsApp(
    ...jids: string[]
  ): Promise<Array<{ jid: string; exists: boolean }>> {
    const result = await this.sock.onWhatsApp(...jids);
    if (!result) return [];
    return result.map((r) => ({ jid: r.jid, exists: Boolean(r.exists) }));
  }

  /**
   * Fetch the URL of a JID's profile picture. Returns `undefined` if the
   * user has no picture set, has hidden it, or blocked the bot.
   *
   * `type` defaults to `"image"` (full resolution); pass `"preview"` for
   * the cheaper, lower-resolution thumbnail.
   *
   * @example
   * const url = await api.fetchProfilePictureUrl(userJid);
   * if (url) await downloadAndCache(url);
   *
   * @example
   * // Thumbnail is much cheaper:
   * const tinyUrl = await api.fetchProfilePictureUrl(userJid, "preview");
   */
  async fetchProfilePictureUrl(
    jid: string,
    type: "image" | "preview" = "image",
  ): Promise<string | undefined> {
    return this.sock.profilePictureUrl(jid, type);
  }

  /**
   * Subscribe to presence updates for a JID. Without this call,
   * `presence.update` events do NOT fire for that JID. Baileys only streams
   * presence for subscribed contacts.
   *
   * Subscriptions are per-socket: they reset on reconnect, so you must
   * re-subscribe (typically from a `connection:open` handler) if you want
   * the stream to persist across reconnects.
   *
   * @example
   * bot.command("watch", async (ctx) => {
   *   await ctx.api.subscribePresence(ctx.chat);
   *   await ctx.reply("watching presence");
   * });
   *
   * bot.on("presence:typing", (ctx) => {
   *   console.log(`${ctx.chat} is typing`);
   * });
   */
  async subscribePresence(jid: string): Promise<void> {
    await this.sock.presenceSubscribe(jid);
  }
}
