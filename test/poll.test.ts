import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WAMessage } from "@whiskeysockets/baileys";

// The actual AES decryption is Baileys' job and needs real key material, so
// it is mocked. These tests cover everything around it: key extraction,
// author resolution, and the hash-to-option-name mapping.
const { decryptPollVoteMock } = vi.hoisted(() => ({
  decryptPollVoteMock: vi.fn(),
}));
vi.mock("@whiskeysockets/baileys", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("@whiskeysockets/baileys")>();
  return { ...mod, decryptPollVote: decryptPollVoteMock };
});

import { readPollVote } from "../src/helpers/poll.js";

const ME = "5599888877776@s.whatsapp.net";
const VOTER = "5511999998888@s.whatsapp.net";

const sha = (s: string) => createHash("sha256").update(s).digest();

function pollCreation(overrides?: Partial<WAMessage["message"]>): WAMessage {
  return {
    key: { remoteJid: "123@g.us", fromMe: true, id: "POLL1" },
    message: {
      pollCreationMessageV3: {
        name: "Pizza?",
        options: [{ optionName: "sim" }, { optionName: "nao" }],
      },
      messageContextInfo: { messageSecret: new Uint8Array([1, 2, 3]) },
      ...overrides,
    },
  } as WAMessage;
}

function pollVote(): WAMessage {
  return {
    key: {
      remoteJid: "123@g.us",
      fromMe: false,
      id: "VOTE1",
      participant: VOTER,
    },
    message: {
      pollUpdateMessage: {
        pollCreationMessageKey: {
          remoteJid: "123@g.us",
          fromMe: true,
          id: "POLL1",
        },
        vote: { encPayload: new Uint8Array([9]), encIv: new Uint8Array([8]) },
      },
    },
  } as WAMessage;
}

beforeEach(() => {
  decryptPollVoteMock.mockReset();
});

describe("readPollVote", () => {
  it("resolves voter and maps option hashes back to names", () => {
    decryptPollVoteMock.mockReturnValue({ selectedOptions: [sha("sim")] });

    const out = readPollVote({
      vote: pollVote(),
      creation: pollCreation(),
      meId: ME,
    });

    expect(out).toEqual({ voter: VOTER, selectedOptions: ["sim"] });
  });

  it("passes the creation messageSecret and key data to the decryptor", () => {
    decryptPollVoteMock.mockReturnValue({ selectedOptions: [] });
    const creation = pollCreation();

    readPollVote({ vote: pollVote(), creation, meId: ME });

    expect(decryptPollVoteMock).toHaveBeenCalledWith(
      { encPayload: new Uint8Array([9]), encIv: new Uint8Array([8]) },
      {
        pollCreatorJid: ME, // creation key is fromMe, so the bot created it
        pollMsgId: "POLL1",
        pollEncKey: creation.message!.messageContextInfo!.messageSecret,
        voterJid: VOTER,
      },
    );
  });

  it("returns an empty selection for a retracted vote", () => {
    decryptPollVoteMock.mockReturnValue({ selectedOptions: [] });

    const out = readPollVote({
      vote: pollVote(),
      creation: pollCreation(),
      meId: ME,
    });
    expect(out.selectedOptions).toEqual([]);
  });

  it("keeps multi-select votes and drops hashes of unknown options", () => {
    decryptPollVoteMock.mockReturnValue({
      selectedOptions: [sha("nao"), sha("sim"), sha("banana")],
    });

    const out = readPollVote({
      vote: pollVote(),
      creation: pollCreation(),
      meId: ME,
    });
    expect(out.selectedOptions).toEqual(["nao", "sim"]);
  });

  it("throws when the vote message carries no pollUpdateMessage", () => {
    const notAVote = {
      key: { remoteJid: "123@g.us", id: "X" },
      message: { conversation: "oi" },
    } as WAMessage;

    expect(() =>
      readPollVote({ vote: notAVote, creation: pollCreation(), meId: ME }),
    ).toThrow(/no pollUpdateMessage/);
  });

  it("throws when the creation message is not a poll", () => {
    const notAPoll = {
      key: { remoteJid: "123@g.us", id: "Y" },
      message: { conversation: "oi" },
    } as WAMessage;

    expect(() =>
      readPollVote({ vote: pollVote(), creation: notAPoll, meId: ME }),
    ).toThrow(/not a poll creation message/);
  });

  it("throws when the creation message lacks the messageSecret", () => {
    const creation = pollCreation({ messageContextInfo: {} });

    expect(() =>
      readPollVote({ vote: pollVote(), creation, meId: ME }),
    ).toThrow(/messageSecret/);
  });
});
