/**
 * Text rules for Slack messages: removing the bot's own mention from incoming text and
 * making outgoing text safe to post. Outgoing text comes from a model, so it is escaped
 * before the requester mention is added; otherwise it could ping `<!channel>` or fake a
 * mention. Markdown is converted to Slack mrkdwn after escaping, so the only Slack syntax the
 * conversion can produce is a link to an http(s) URL the text already named.
 *
 * @module slackMessageFormatting
 */
import { chunkFenceAware } from "./slackMessageChunking.ts";

/** Slack recommends keeping message text under this length. */
export const SLACK_TEXT_LIMIT = 4000;
/** Raw text per message before escaping, leaving room for the mention and entity growth. */
const SLACK_CHUNK_LIMIT = 3500;
/** A reply longer than this many messages ends with a note instead of flooding the thread. */
export const SLACK_MAX_MESSAGES = 10;
export const SLACK_TRUNCATED_NOTE = "… The rest of this reply was too long for Slack.";

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

const CODE_SPAN = /```[\s\S]*?```|`[^`\n]+`/g;
// A private-use character marks stashed code; any copy in the input is removed first.
const STASH = "\uE000";

/**
 * Converts the Markdown models write into mrkdwn: links, bold, strikethrough and headings.
 * Code spans and blocks are left as they are, and fence language tags, which Slack would show
 * as text, are dropped. Single `*` or `_` stays, since mrkdwn reads it as bold or italic anyway.
 * Rules adapted from cli-jaw's src/slack/format.ts (MIT).
 */
export function toSlackMrkdwn(escaped: string): string {
  const stash: Array<string> = [];
  const hidden = escaped.replaceAll(STASH, "").replace(CODE_SPAN, (span) => {
    stash.push(span);
    return STASH + (stash.length - 1) + STASH;
  });
  const converted = hidden
    // [label](https://url) becomes <url|label>; a "|" in the URL would end it early.
    .replace(
      /\[((?:[^\][\n]|\[[^\][\n]*\])+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_match, label: string, url: string) => "<" + url.replaceAll("|", "%7C") + "|" + label + ">",
    )
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "*_$1_*")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, (_match, title: string) =>
      title.startsWith("*") && title.endsWith("*") ? title : "*" + title + "*",
    );
  return converted
    .replace(/\uE000(\d+)\uE000/g, (_match, index: string) => stash[Number(index)] ?? "")
    .replace(/^```[A-Za-z0-9_+#.-]+\n/gm, "```\n");
}

/** Raw pieces whose escaped, converted form fits in one message after the mention. */
function fittingPieces(text: string, room: number, limit = SLACK_CHUNK_LIMIT): Array<string> {
  return chunkFenceAware(text, Math.min(limit, room)).flatMap((piece) => {
    const formatted = toSlackMrkdwn(escapeSlackText(piece)).length;
    if (formatted <= room || piece.length <= 64) return [piece];
    // Escaping grew it: split again in proportion, leaving a little room for fence markers.
    const smaller = Math.floor((piece.length * room) / formatted) - 16;
    return fittingPieces(piece, room, Math.max(64, Math.min(smaller, piece.length - 1)));
  });
}

/**
 * The messages one reply posts as: escaped, converted to mrkdwn, split where Slack would cut it,
 * with the requester mentioned at the start of the first when the ID is valid. Nothing is
 * dropped unless the reply runs past {@link SLACK_MAX_MESSAGES}.
 */
export function formatSlackOutboundMessages(input: {
  readonly text: string;
  readonly mentionUserId?: string | undefined;
}): Array<string> {
  const mention =
    input.mentionUserId !== undefined && SLACK_USER_ID.test(input.mentionUserId)
      ? `<@${input.mentionUserId}> `
      : "";
  const room = SLACK_TEXT_LIMIT - mention.length;
  const pieces = fittingPieces(input.text.trim(), room);
  const kept =
    pieces.length <= SLACK_MAX_MESSAGES
      ? pieces
      : [...pieces.slice(0, SLACK_MAX_MESSAGES - 1), SLACK_TRUNCATED_NOTE];
  return kept.map(
    (piece, index) =>
      (index === 0 ? mention : "") +
      toSlackMrkdwn(escapeSlackText(piece)).replace(/^\n+/, "").trimEnd(),
  );
}

/** Slack's plain-text button label limit, and the section text limit. */
const SLACK_BUTTON_TEXT_LIMIT = 75;
const SLACK_SECTION_TEXT_LIMIT = 3000;
/** Slack's button value limit. A longer label stays in the numbered list and has no button. */
const SLACK_BUTTON_VALUE_LIMIT = 2000;

const slackChoiceActionId = (index: number): string => `goat_choice_${index + 1}`;

/** True only for buttons this adapter posts. Other action ids are ignored. */
export const isSlackChoiceActionId = (actionId: string): boolean =>
  /^goat_choice_[1-9]\d*$/.test(actionId);

export interface SlackChoiceButton {
  readonly type: "button";
  readonly action_id: string;
  readonly value: string;
  readonly text: { readonly type: "plain_text"; readonly text: string; readonly emoji: false };
}

export type SlackChoiceBlock =
  | {
      readonly type: "section";
      readonly text: { readonly type: "mrkdwn"; readonly text: string };
    }
  | {
      readonly type: "actions";
      readonly block_id: "goat_choices";
      readonly elements: ReadonlyArray<SlackChoiceButton>;
    };

const buttonText = (label: string) =>
  label.length <= SLACK_BUTTON_TEXT_LIMIT
    ? label
    : label.slice(0, SLACK_BUTTON_TEXT_LIMIT - 1) + "…";

/**
 * Block Kit for a card or question: the fallback text in a section, and one button per option.
 * The button value is the option label, which reception reads as the person's reply.
 */
export const slackChoiceBlocks = (
  text: string,
  options: ReadonlyArray<string>,
): ReadonlyArray<SlackChoiceBlock> | undefined => {
  const elements = options.flatMap((option, index) =>
    option.length === 0 || option.length > SLACK_BUTTON_VALUE_LIMIT
      ? []
      : [
          {
            type: "button" as const,
            action_id: slackChoiceActionId(index),
            value: option,
            text: { type: "plain_text" as const, text: buttonText(option), emoji: false as const },
          },
        ],
  );
  if (elements.length === 0) return undefined;
  const section =
    text.length <= SLACK_SECTION_TEXT_LIMIT
      ? text
      : text.slice(0, SLACK_SECTION_TEXT_LIMIT - 1) + "…";
  return [
    { type: "section", text: { type: "mrkdwn", text: section } },
    { type: "actions", block_id: "goat_choices", elements },
  ];
};
