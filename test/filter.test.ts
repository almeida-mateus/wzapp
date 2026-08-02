import { describe, expect, it } from "vitest";
import { matchFilter } from "../src/filter.js";
import type { WhatsappUpdate } from "../src/update.js";

/* ─── Fixtures ────────────────────────────────────────────────────────── */

function textMessage(text: string, fromMe = false): WhatsappUpdate {
  return {
    type: "message",
    message: {
      key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe, id: "X" },
      message: { conversation: text },
    },
  } as WhatsappUpdate;
}

function imageMessage(caption?: string): WhatsappUpdate {
  return {
    type: "message",
    message: {
      key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "X" },
      message: {
        imageMessage: caption !== undefined ? { caption } : {},
      },
    },
  } as WhatsappUpdate;
}

function voiceMessage(): WhatsappUpdate {
  return {
    type: "message",
    message: {
      key: { remoteJid: "g@g.us", fromMe: false, id: "X" },
      message: { audioMessage: { ptt: true } },
    },
  } as WhatsappUpdate;
}

function mediaMessage(inner: Record<string, unknown>): WhatsappUpdate {
  return {
    type: "message",
    message: {
      key: { remoteJid: "5511999999999@s.whatsapp.net", fromMe: false, id: "X" },
      message: inner,
    },
  } as WhatsappUpdate;
}

function reactionUpdate(emoji: string): WhatsappUpdate {
  return {
    type: "reaction",
    reactions: [
      { key: { id: "X", remoteJid: "g@g.us", fromMe: false }, reaction: { text: emoji } },
    ],
  } as WhatsappUpdate;
}

function groupParticipantsUpdate(
  action: "add" | "remove" | "promote" | "demote",
): WhatsappUpdate {
  return {
    type: "group_participants",
    jid: "g@g.us",
    participants: [{ id: "x@s.whatsapp.net" }],
    action,
  };
}

/* ─── Tests ──────────────────────────────────────────────────────────── */

describe("matchFilter", () => {
  describe("level-0 type matching", () => {
    it("matches by bare type", () => {
      expect(matchFilter("message")(textMessage("hi"))).toBe(true);
      expect(matchFilter("message")(reactionUpdate("👍"))).toBe(false);
    });

    it("treats `msg` as alias for `message`", () => {
      expect(matchFilter("msg")(textMessage("hi"))).toBe(true);
    });

    it("matches reaction updates", () => {
      expect(matchFilter("reaction")(reactionUpdate("❤"))).toBe(true);
      expect(matchFilter("reaction")(textMessage("hi"))).toBe(false);
    });
  });

  describe("message:* predicates", () => {
    it("message:text only matches text messages", () => {
      expect(matchFilter("message:text")(textMessage("hi"))).toBe(true);
      expect(matchFilter("message:text")(imageMessage())).toBe(false);
    });

    it("`text` alone is an alias for `message:text`", () => {
      expect(matchFilter("text")(textMessage("hi"))).toBe(true);
      expect(matchFilter("text")(imageMessage())).toBe(false);
    });

    it("message:image matches image messages", () => {
      expect(matchFilter("message:image")(imageMessage("cap"))).toBe(true);
      expect(matchFilter("message:image")(textMessage("hi"))).toBe(false);
    });

    it("message:voice matches only audio with ptt=true", () => {
      expect(matchFilter("message:voice")(voiceMessage())).toBe(true);
      expect(matchFilter("message:voice")(textMessage("hi"))).toBe(false);
    });

    it("message:caption requires a non-empty caption", () => {
      expect(matchFilter("message:caption")(imageMessage("cap"))).toBe(true);
      expect(matchFilter("message:caption")(imageMessage())).toBe(false);
      expect(matchFilter("message:caption")(imageMessage(""))).toBe(false);
    });

    it("message:from_me looks at key.fromMe", () => {
      expect(matchFilter("message:from_me")(textMessage("hi", true))).toBe(true);
      expect(matchFilter("message:from_me")(textMessage("hi", false))).toBe(false);
    });

    it("message:private vs message:group is JID-based", () => {
      const priv = textMessage("hi");
      const group: WhatsappUpdate = {
        type: "message",
        message: {
          key: { remoteJid: "1234@g.us", fromMe: false, id: "Y" },
          message: { conversation: "hi" },
        },
      } as WhatsappUpdate;
      expect(matchFilter("message:private")(priv)).toBe(true);
      expect(matchFilter("message:private")(group)).toBe(false);
      expect(matchFilter("message:group")(group)).toBe(true);
      expect(matchFilter("message:group")(priv)).toBe(false);
    });
  });

  describe("message:poll shapes", () => {
    it("matches every poll-creation shape, including V4/V5", () => {
      const poll = matchFilter("message:poll");
      expect(poll(mediaMessage({ pollCreationMessage: {} }))).toBe(true);
      expect(poll(mediaMessage({ pollCreationMessageV2: {} }))).toBe(true);
      expect(poll(mediaMessage({ pollCreationMessageV3: {} }))).toBe(true);
      expect(poll(mediaMessage({ pollCreationMessageV4: { message: {} } }))).toBe(true);
      expect(poll(mediaMessage({ pollCreationMessageV5: {} }))).toBe(true);
      expect(poll(textMessage("hi"))).toBe(false);
    });
  });

  describe("media shortcut", () => {
    it("matches each media variant", () => {
      const media = matchFilter("media");
      expect(media(imageMessage())).toBe(true);
      expect(media(mediaMessage({ videoMessage: {} }))).toBe(true);
      expect(media(mediaMessage({ audioMessage: { ptt: false } }))).toBe(true);
      expect(media(voiceMessage())).toBe(true);
      expect(media(mediaMessage({ documentMessage: {} }))).toBe(true);
      expect(media(mediaMessage({ stickerMessage: {} }))).toBe(true);
      expect(media(textMessage("hi"))).toBe(false);
    });
  });

  describe("group:participants:*", () => {
    it("matches the corresponding action only", () => {
      expect(
        matchFilter("group:participants:add")(groupParticipantsUpdate("add")),
      ).toBe(true);
      expect(
        matchFilter("group:participants:add")(
          groupParticipantsUpdate("remove"),
        ),
      ).toBe(false);
      expect(
        matchFilter("group:participants:promote")(
          groupParticipantsUpdate("promote"),
        ),
      ).toBe(true);
    });
  });

  describe("reaction:added vs reaction:removed", () => {
    it("distinguishes by emoji presence", () => {
      const added = reactionUpdate("🎉");
      const removed = reactionUpdate("");
      expect(matchFilter("reaction:added")(added)).toBe(true);
      expect(matchFilter("reaction:added")(removed)).toBe(false);
      expect(matchFilter("reaction:removed")(removed)).toBe(true);
      expect(matchFilter("reaction:removed")(added)).toBe(false);
    });
  });

  describe("array form (OR)", () => {
    it("matches when any of the listed queries fires", () => {
      const pred = matchFilter(["message:image", "message:video"]);
      expect(pred(imageMessage())).toBe(true);
      expect(pred(textMessage("hi"))).toBe(false);
    });
  });

  describe("invalid queries", () => {
    it("throws on unknown level-0 head", () => {
      // Cast through unknown because the type union forbids this at compile
      // time, but we exercise the runtime guard.
      expect(() => matchFilter("nope" as unknown as "message")).toThrow();
    });
  });
});
