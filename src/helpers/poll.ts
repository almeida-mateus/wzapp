import { createHash } from "node:crypto";
import {
  decryptPollVote,
  getKeyAuthor,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import type { WAMessage } from "@whiskeysockets/baileys";

/**
 * A decrypted poll vote, with the option hashes already resolved back to
 * the option names from the creation message.
 */
export interface PollVote {
  /** JID of the voter. */
  voter: string;
  /**
   * The voter's full current selection. Every vote event carries the whole
   * selection, not a delta: voting again replaces the previous selection,
   * and an empty array means the voter retracted their vote. Hashes that
   * match no option of the given creation message are dropped.
   */
  selectedOptions: string[];
}

/** Poll-creation content across the shapes the filter DSL recognizes. */
function getPollCreationContent(m: WAMessage) {
  const inner = m.message;
  return (
    inner?.pollCreationMessage ??
    inner?.pollCreationMessageV2 ??
    inner?.pollCreationMessageV3 ??
    undefined
  );
}

/**
 * Decrypts a poll vote (`pollUpdateMessage`) and maps the selected-option
 * hashes back to option names.
 *
 * WhatsApp encrypts votes with a key (`messageSecret`) that only exists
 * inside the poll creation message, so the caller must supply that message.
 * Store it when the poll is created: {@link Context.replyWithPoll} returns
 * it for polls the bot sends, and `message:poll` handlers receive it for
 * polls created by others.
 *
 * Inside a `message:poll:vote` handler, prefer the
 * {@link Context.decryptPollVote} wrapper, which fills in `vote` and `meId`.
 *
 * @throws When `vote` carries no `pollUpdateMessage`, when `creation` is not
 * a poll creation message, or when `creation` lacks the `messageSecret`.
 */
export function readPollVote(args: {
  /** The message carrying the vote (`pollUpdateMessage`). */
  vote: WAMessage;
  /** The poll creation message the vote belongs to. */
  creation: WAMessage;
  /** The bot's own JID, used to resolve `fromMe` keys to an author. */
  meId: string;
}): PollVote {
  const { vote, creation, meId } = args;

  const upd = vote.message?.pollUpdateMessage;
  if (!upd?.vote) {
    throw new Error("readPollVote: `vote` carries no pollUpdateMessage");
  }
  const content = getPollCreationContent(creation);
  if (!content) {
    throw new Error(
      "readPollVote: `creation` is not a poll creation message",
    );
  }
  const pollEncKey = creation.message?.messageContextInfo?.messageSecret;
  if (!pollEncKey) {
    throw new Error(
      "readPollVote: `creation` has no messageSecret, so its votes cannot be decrypted",
    );
  }
  const creationKey = upd.pollCreationMessageKey ?? creation.key;
  if (!creationKey?.id) {
    throw new Error("readPollVote: poll creation key has no message id");
  }

  const me = jidNormalizedUser(meId);
  const voter = getKeyAuthor(vote.key, me);
  const decrypted = decryptPollVote(upd.vote, {
    pollCreatorJid: getKeyAuthor(creationKey, me),
    pollMsgId: creationKey.id,
    pollEncKey,
    voterJid: voter,
  });

  const nameByHash = new Map<string, string>();
  for (const option of content.options ?? []) {
    if (!option?.optionName) continue;
    const hash = createHash("sha256").update(option.optionName).digest("hex");
    nameByHash.set(hash, option.optionName);
  }
  const selectedOptions = (decrypted.selectedOptions ?? [])
    .map((h) => nameByHash.get(Buffer.from(h).toString("hex")))
    .filter((name): name is string => name !== undefined);

  return { voter, selectedOptions };
}
