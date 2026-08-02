import { describe, expect, it } from "vitest";
import {
  fromBlocklistUpdate,
  fromConnectionUpdate,
  fromGroupParticipantsUpdate,
  fromMessagesDelete,
  fromMessagesUpsert,
} from "../src/update.js";
import type { WAMessage } from "@whiskeysockets/baileys";

describe("fromMessagesUpsert", () => {
  it("emits one update per non-protocol message", () => {
    const messages = [
      {
        key: { remoteJid: "a@s.whatsapp.net", fromMe: false, id: "1" },
        message: { conversation: "hi" },
      },
      {
        key: { remoteJid: "b@s.whatsapp.net", fromMe: false, id: "2" },
        message: { imageMessage: {} },
      },
    ] as unknown as WAMessage[];
    const out = fromMessagesUpsert({ messages, type: "notify" });
    expect(out).toHaveLength(2);
    expect(out[0]?.type).toBe("message");
  });

  it("drops pure protocol envelopes", () => {
    const messages = [
      {
        key: { remoteJid: "a@s.whatsapp.net", fromMe: false, id: "X" },
        message: { protocolMessage: { type: 0 } },
      },
    ] as unknown as WAMessage[];
    const out = fromMessagesUpsert({ messages, type: "notify" });
    expect(out).toHaveLength(0);
  });

  it("keeps messages that have protocolMessage alongside real content", () => {
    const messages = [
      {
        key: { remoteJid: "a@s.whatsapp.net", fromMe: false, id: "Y" },
        message: {
          protocolMessage: { type: 0 },
          conversation: "hi",
        },
      },
    ] as unknown as WAMessage[];
    const out = fromMessagesUpsert({ messages, type: "notify" });
    expect(out).toHaveLength(1);
  });

  it("drops messages with no inner content at all", () => {
    const messages = [
      { key: { remoteJid: "a", fromMe: false, id: "Z" }, message: null },
    ] as unknown as WAMessage[];
    expect(fromMessagesUpsert({ messages, type: "notify" })).toHaveLength(0);
  });
});

describe("fromMessagesDelete", () => {
  it("emits an update for the `keys` shape", () => {
    const out = fromMessagesDelete({
      keys: [{ id: "X", remoteJid: "a", fromMe: false }],
    });
    expect(out).toHaveLength(1);
    if (out[0]?.type === "message_delete") {
      expect(out[0].keys).toHaveLength(1);
    }
  });

  it("returns empty array for the `{ jid, all }` shape", () => {
    expect(fromMessagesDelete({ jid: "x", all: true })).toHaveLength(0);
  });
});

describe("fromGroupParticipantsUpdate", () => {
  it("forwards action values", () => {
    const out = fromGroupParticipantsUpdate({
      id: "g@g.us",
      participants: [{ id: "x@s.whatsapp.net" }],
      action: "add",
    });
    expect(out).toHaveLength(1);
    if (out[0]?.type === "group_participants") {
      expect(out[0].action).toBe("add");
      expect(out[0].jid).toBe("g@g.us");
    }
  });

  it("passes through the Baileys 7 author fields", () => {
    const out = fromGroupParticipantsUpdate({
      id: "g@g.us",
      participants: [{ id: "x@s.whatsapp.net" }],
      action: "add",
      author: "admin@s.whatsapp.net",
      authorPn: "5511888888888@s.whatsapp.net",
      authorUsername: "admin",
    });
    expect(out).toHaveLength(1);
    if (out[0]?.type === "group_participants") {
      expect(out[0].author).toBe("admin@s.whatsapp.net");
      expect(out[0].authorPn).toBe("5511888888888@s.whatsapp.net");
      expect(out[0].authorUsername).toBe("admin");
    }
  });

  it("drops the `modify` no-op action", () => {
    const out = fromGroupParticipantsUpdate({
      id: "g@g.us",
      participants: [],
      action: "modify",
    });
    expect(out).toHaveLength(0);
  });
});

describe("fromConnectionUpdate", () => {
  it("wraps partial state under `state`", () => {
    const out = fromConnectionUpdate({ connection: "open" });
    expect(out).toEqual([{ type: "connection", state: { connection: "open" } }]);
  });
});

describe("fromBlocklistUpdate", () => {
  it("renames `type` → `action`", () => {
    const out = fromBlocklistUpdate({ blocklist: ["x@s.whatsapp.net"], type: "add" });
    expect(out).toEqual([
      { type: "blocklist", action: "add", jids: ["x@s.whatsapp.net"] },
    ]);
  });
});
