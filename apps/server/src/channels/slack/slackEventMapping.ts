/**
 * Classifies one Socket Mode Events API payload into what the Slack channel should do
 * with it. Pure: no SDK, no clock, no gateway. Slack IDs and timestamps are untrusted,
 * so anything malformed is ignored rather than turned into a conversation key.
 *
 * Only two surfaces are accepted: `app_mention` in channels and `message` in DMs.
 * Plain channel messages are not part of the subscription, which also keeps one Slack
 * message from being ingested twice through both event types.
 *
 * @module slackEventMapping
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { stripBotMention } from "./slackMessageFormatting.ts";

/** Team, channel and user IDs. */
const SlackId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{2,32}$/));
const SlackEventId = Schema.String.check(Schema.isPattern(/^Ev[A-Za-z0-9]{4,64}$/));
const SlackTs = Schema.String.check(Schema.isPattern(/^\d{1,12}\.\d{1,9}$/));

const SlackEventCallback = Schema.Struct({
  type: Schema.Literal("event_callback"),
  team_id: SlackId,
  event_id: SlackEventId,
  event: Schema.Unknown,
});

const SlackMessageEvent = Schema.Struct({
  type: Schema.Literals(["app_mention", "message"]),
  channel: Schema.optionalKey(Schema.String),
  channel_type: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  bot_id: Schema.optionalKey(Schema.String),
  subtype: Schema.optionalKey(Schema.String),
  hidden: Schema.optionalKey(Schema.Boolean),
  text: Schema.optionalKey(Schema.String),
  ts: Schema.optionalKey(Schema.String),
  thread_ts: Schema.optionalKey(Schema.String),
});

const decodeEventCallback = Schema.decodeUnknownOption(SlackEventCallback);
const decodeMessageEvent = Schema.decodeUnknownOption(SlackMessageEvent);
const isSlackId = Schema.is(SlackId);
const isSlackTs = Schema.is(SlackTs);

export interface SlackClassifierConfig {
  /** Workspace the bot token belongs to (`auth.test`). */
  readonly teamId: string;
  readonly botUserId: string;
  /** Channels where mentions are accepted. Empty means none; DMs are always eligible. */
  readonly allowedChannelIds: ReadonlySet<string>;
}

export interface SlackClassifiedMessage {
  readonly teamId: string;
  readonly channelId: string;
  readonly surface: "dm" | "mention";
  readonly userId: string;
  readonly ts: string;
  /** Thread root: `thread_ts ?? ts`. Replies and their root share it. */
  readonly rootTs: string;
  readonly isReply: boolean;
  readonly eventId: string;
  /** `teamId:eventId`. Slack retries resend the same event ID. */
  readonly dedupeKey: string;
  /** `teamId:channelId:rootTs`. One Slack thread is one conversation. */
  readonly conversationKey: string;
  /** Text without the bot mention. Empty for link commands, whose code stays out of it. */
  readonly text: string;
}

export type SlackIgnoredReason =
  | "malformed"
  | "not_event_callback"
  | "unsupported_event"
  | "team_mismatch"
  | "own_bot"
  | "bot_message"
  | "subtype"
  | "hidden"
  | "missing_user"
  | "channel_message"
  | "channel_not_allowed"
  | "empty";

export type SlackEventClassification =
  | { readonly _tag: "ignored"; readonly reason: SlackIgnoredReason }
  | { readonly _tag: "message"; readonly event: SlackClassifiedMessage }
  /** Identity link command in a DM. `code` is undefined when the command is malformed. */
  | {
      readonly _tag: "link";
      readonly event: SlackClassifiedMessage;
      readonly code: string | undefined;
    }
  /** Link command posted in a channel. The code is dropped; the user should DM the bot instead. */
  | { readonly _tag: "link_in_channel"; readonly event: SlackClassifiedMessage };

const ignored = (reason: SlackIgnoredReason): SlackEventClassification => ({
  _tag: "ignored",
  reason,
});

const LINK_COMMAND = /^link(?:\s+(\S+))?\s*$/i;
const LINK_PREFIX = /^link\b/i;

export function classifySlackEvent(
  body: unknown,
  config: SlackClassifierConfig,
): SlackEventClassification {
  const callback = decodeEventCallback(body);
  if (Option.isNone(callback)) {
    const type =
      typeof body === "object" && body !== null && "type" in body ? body.type : undefined;
    return ignored(type === "event_callback" ? "malformed" : "not_event_callback");
  }
  const { team_id: teamId, event_id: eventId } = callback.value;
  const decodedEvent = decodeMessageEvent(callback.value.event);
  if (Option.isNone(decodedEvent)) return ignored("unsupported_event");
  const event = decodedEvent.value;

  if (teamId !== config.teamId) return ignored("team_mismatch");
  if (event.bot_id !== undefined || event.subtype === "bot_message") return ignored("bot_message");
  if (event.user === config.botUserId) return ignored("own_bot");
  if (event.subtype !== undefined) return ignored("subtype");
  if (event.hidden === true) return ignored("hidden");
  const { user: userId, channel: channelId, ts, thread_ts: threadTs } = event;
  if (userId === undefined) return ignored("missing_user");
  if (
    !isSlackId(userId) ||
    channelId === undefined ||
    !isSlackId(channelId) ||
    ts === undefined ||
    !isSlackTs(ts) ||
    (threadTs !== undefined && !isSlackTs(threadTs))
  ) {
    return ignored("malformed");
  }

  const isDirectMessage = event.channel_type === "im";
  if (event.type === "message" && !isDirectMessage) return ignored("channel_message");
  const surface = isDirectMessage ? "dm" : "mention";
  if (surface === "mention" && !config.allowedChannelIds.has(channelId)) {
    return ignored("channel_not_allowed");
  }

  const rootTs = threadTs ?? ts;
  const text = stripBotMention(event.text ?? "", config.botUserId);
  const classified = (messageText: string): SlackClassifiedMessage => ({
    teamId,
    channelId,
    surface,
    userId,
    ts,
    rootTs,
    isReply: threadTs !== undefined && threadTs !== ts,
    eventId,
    dedupeKey: `${teamId}:${eventId}`,
    conversationKey: `${teamId}:${channelId}:${rootTs}`,
    text: messageText,
  });

  if (LINK_PREFIX.test(text)) {
    if (surface === "mention") return { _tag: "link_in_channel", event: classified("") };
    const code = LINK_COMMAND.exec(text)?.[1];
    return { _tag: "link", event: classified(""), code };
  }
  if (text.length === 0) return ignored("empty");
  return { _tag: "message", event: classified(text) };
}
