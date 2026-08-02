const GROUP_SUFFIX = "@g.us";
const PRIVATE_SUFFIX = "@s.whatsapp.net";
const LID_SUFFIX = "@lid";
const BROADCAST_SUFFIX = "@broadcast";
const STATUS_BROADCAST = "status@broadcast";
const NEWSLETTER_SUFFIX = "@newsletter";

export function isGroupJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.endsWith(GROUP_SUFFIX);
}

export function isPrivateJid(jid: string | null | undefined): boolean {
  return (
    typeof jid === "string" &&
    (jid.endsWith(PRIVATE_SUFFIX) || jid.endsWith(LID_SUFFIX))
  );
}

export function isBroadcastJid(jid: string | null | undefined): boolean {
  return (
    typeof jid === "string" &&
    (jid === STATUS_BROADCAST || jid.endsWith(BROADCAST_SUFFIX))
  );
}

export function isStatusBroadcast(jid: string | null | undefined): boolean {
  return jid === STATUS_BROADCAST;
}

export function isNewsletterJid(jid: string | null | undefined): boolean {
  return typeof jid === "string" && jid.endsWith(NEWSLETTER_SUFFIX);
}

/**
 * Returns the user portion of a JID (everything before `@`). Input without an
 * `@` is returned unchanged; `undefined` only for empty or non-string input.
 */
export function extractJid(jid: string | null | undefined): string | undefined {
  if (typeof jid !== "string" || jid.length === 0) return undefined;
  const at = jid.indexOf("@");
  if (at < 0) return jid;
  return jid.slice(0, at);
}
