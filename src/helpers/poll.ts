import { createHash } from "node:crypto";
import {
  decryptPollVote,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";

/**
 * A decrypted poll vote, with the option hashes already resolved back to
 * the option names from the creation message.
 */
export interface PollVote {
  /**
   * JID of the voter, in whichever form (`@s.whatsapp.net` or `@lid`)
   * authenticated the decryption.
   */
  voter: string;
  /**
   * The voter's full current selection. Every vote event carries the whole
   * selection, not a delta: voting again replaces the previous selection,
   * and an empty array means the voter retracted their vote. Hashes that
   * match no option of the given creation message are dropped.
   */
  selectedOptions: string[];
}

/**
 * Poll-creation content across the shapes the filter DSL recognizes. `V4`
 * is a `FutureProofMessage` envelope, so its inner message is checked for
 * the same fields.
 */
function getPollCreationContent(m: WAMessage) {
  const inner = m.message;
  const direct =
    inner?.pollCreationMessage ??
    inner?.pollCreationMessageV2 ??
    inner?.pollCreationMessageV3 ??
    inner?.pollCreationMessageV5;
  if (direct) return direct;

  const wrapped = inner?.pollCreationMessageV4?.message;
  return (
    wrapped?.pollCreationMessage ??
    wrapped?.pollCreationMessageV2 ??
    wrapped?.pollCreationMessageV3 ??
    wrapped?.pollCreationMessageV5 ??
    undefined
  );
}

/**
 * JID forms that may identify the author of `key` in the vote's additional
 * authenticated data. Phone-number and lid forms both occur in the wild
 * (lid-addressed groups sign with `@lid` JIDs), so every known form is a
 * candidate, most likely first.
 */
function authorCandidates(
  key: (WAMessageKey & { participantAlt?: string }) | null | undefined,
  self: string[],
): string[] {
  if (!key) return [];
  if (key.fromMe) return self;
  const out: string[] = [];
  const forms = [
    key.participant,
    key.participantAlt,
    key.remoteJid,
    key.remoteJidAlt,
  ];
  for (const form of forms) {
    if (!form) continue;
    const jid = jidNormalizedUser(form);
    if (jid && !out.includes(jid)) out.push(jid);
  }
  return out;
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
 * The vote's authenticated data binds the creator and voter JIDs, and
 * lid-addressed chats sign with `@lid` forms while others use phone-number
 * forms. Decryption therefore tries every known form of both JIDs until one
 * combination authenticates; wrong combinations fail cleanly, so this cannot
 * mis-decrypt.
 *
 * Inside a `message:poll:vote` handler, prefer the
 * {@link Context.decryptPollVote} wrapper, which fills in `vote`, `meId`,
 * and `meLid`.
 *
 * @throws When `vote` carries no `pollUpdateMessage`, when `creation` is not
 * a poll creation message, when `creation` lacks the `messageSecret`, or
 * when no JID combination authenticates (usually a creation message that
 * does not match this vote).
 */
export function readPollVote(args: {
  /** The message carrying the vote (`pollUpdateMessage`). */
  vote: WAMessage;
  /** The poll creation message the vote belongs to. */
  creation: WAMessage;
  /** The bot's own JID, used to resolve `fromMe` keys to an author. */
  meId: string;
  /** The bot's lid JID, tried as an alternative form for `fromMe` keys. */
  meLid?: string;
}): PollVote {
  const { vote, creation, meId, meLid } = args;

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

  const self = [meId, meLid]
    .filter((j): j is string => !!j)
    .map((j) => jidNormalizedUser(j))
    .filter((j, i, all) => !!j && all.indexOf(j) === i);
  const creators = authorCandidates(creationKey, self);
  const voters = authorCandidates(vote.key, self);

  let decrypted: ReturnType<typeof decryptPollVote> | undefined;
  let voter: string | undefined;
  let lastError: unknown;
  for (const creator of creators) {
    for (const candidate of voters) {
      try {
        decrypted = decryptPollVote(upd.vote, {
          pollCreatorJid: creator,
          pollMsgId: creationKey.id,
          pollEncKey,
          voterJid: candidate,
        });
        voter = candidate;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (decrypted) break;
  }
  if (!decrypted || voter === undefined) {
    throw new Error(
      "readPollVote: vote decryption failed for every known JID combination. " +
        "The supplied creation message probably does not match this vote " +
        "(verify its messageSecret and message id).",
      { cause: lastError },
    );
  }

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
