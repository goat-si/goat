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
