/**
 * Text rules for Slack messages: removing the bot's own mention from incoming text and
 * making outgoing text safe to post. Outgoing text comes from a model, so it is escaped
 * before the requester mention is added; otherwise it could ping `<!channel>` or fake a
 * mention.
 *
 * @module slackMessageFormatting
 */

/** Slack recommends keeping message text under this length. */
export const SLACK_TEXT_LIMIT = 4000;

const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes `<@BOT>` and `<@BOT|name>` tokens for this bot only, then tidies whitespace. */
export function stripBotMention(text: string, botUserId: string): string {
  const mention = new RegExp(`<@${escapeRegExp(botUserId)}(?:\\|[^>]*)?>`, "g");
  return text
    .replace(mention, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Escapes the three characters Slack treats as control syntax. */
function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escaped, length-limited text, with the requester mentioned first when the ID is valid. */
export function formatSlackOutboundText(input: {
  readonly text: string;
  readonly mentionUserId?: string | undefined;
}): string {
  const mention =
    input.mentionUserId !== undefined && SLACK_USER_ID.test(input.mentionUserId)
      ? `<@${input.mentionUserId}> `
      : "";
  const limit = SLACK_TEXT_LIMIT - mention.length;
  const escaped = escapeSlackText(input.text.trim());
  const body =
    escaped.length > limit
      ? `${escaped.slice(0, limit - 1).replace(/&[a-z]{0,3}$/, "")}…`
      : escaped;
  return `${mention}${body}`;
}
