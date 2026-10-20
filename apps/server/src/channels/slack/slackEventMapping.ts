/**
 * Classifies one Socket Mode Events API payload into what the Slack channel should do
 * with it. Pure: no SDK, no clock, no gateway. Slack IDs and timestamps are untrusted,
 * so anything malformed is ignored rather than turned into a conversation key.
 *
 * Only two surfaces are accepted: `app_mention` in channels and `message` in DMs.
 * Plain channel messages are not part of the subscription, which also keeps one Slack
 * message from being ingested twice through both event types.
 *
 * Button presses arrive as `interactive` payloads, not events. Only a `goat_choice_`
 * action is accepted, and only the user id, team, channel, and thread timestamp are
 * read. The button value is the reply text. Everything else in the payload is ignored.
 *
 * @module slackEventMapping
 */
import type {
  ChannelActorRef,
  ChannelInboundMessage,
  ChannelNoticeKind,
  ChannelReplyAddress,
} from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isSlackChoiceActionId, stripBotMention } from "./slackMessageFormatting.ts";

/** Team, channel and user IDs. */
const SlackId = Schema.String.check(Schema.isPattern(/^[A-Z0-9]{2,32}$/));
const SlackEventId = Schema.String.check(Schema.isPattern(/^Ev[A-Za-z0-9]{4,64}$/));
const SlackTs = Schema.String.check(Schema.isPattern(/^\d{1,12}\.\d{1,9}$/));

const SlackEventCallback = Schema.Struct({
  type: Schema.Literal("event_callback"),
  team_id: SlackId,
  event_id: SlackEventId,
  event: Schema.Unknown,
  event_time: Schema.optionalKey(Schema.Number),
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

const SlackRevocation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tokens_revoked"),
    tokens: Schema.Struct({ bot: Schema.optionalKey(Schema.Array(Schema.String)) }),
  }),
  Schema.Struct({ type: Schema.Literal("app_uninstalled") }),
]);
const decodeRevocation = Schema.decodeUnknownOption(SlackRevocation);
export interface SlackRevocationEvent {
  readonly kind: "tokens_revoked" | "app_uninstalled";
  readonly eventTime: number;
}

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
  | { readonly _tag: "revocation"; readonly event: SlackRevocationEvent }
  | { readonly _tag: "message"; readonly event: SlackClassifiedMessage }
  /** `link CODE` sent to the bot in a DM. */
  | { readonly _tag: "link"; readonly event: SlackClassifiedMessage; readonly code: string }
  /**
   * A link command that cannot be used: no code, extra words, or posted in a channel where the
   * code would be public. Any code is dropped; the gateway sends the matching notice.
   */
  | {
      readonly _tag: "link_notice";
      readonly event: SlackClassifiedMessage;
      readonly notice: ChannelNoticeKind;
    };

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
  if (teamId !== config.teamId) return ignored("team_mismatch");
  const revocation = decodeRevocation(callback.value.event);
  if (Option.isSome(revocation)) {
    const eventTime = callback.value.event_time;
    if (eventTime === undefined || !Number.isFinite(eventTime) || eventTime < 0)
      return ignored("malformed");
    const event = revocation.value;
    if (event.type === "tokens_revoked" && !event.tokens.bot?.includes(config.botUserId))
      return ignored("unsupported_event");
    return { _tag: "revocation", event: { kind: event.type, eventTime } };
  }
  const decodedEvent = decodeMessageEvent(callback.value.event);
  if (Option.isNone(decodedEvent)) return ignored("unsupported_event");
  const event = decodedEvent.value;

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
    if (surface === "mention") {
      return { _tag: "link_notice", event: classified(""), notice: "link_help" };
    }
    const command = LINK_COMMAND.exec(text);
    if (command === null) {
      return { _tag: "link_notice", event: classified(""), notice: "link_invalid" };
    }
    const code = command[1];
    return code === undefined
      ? { _tag: "link_notice", event: classified(""), notice: "link_help" }
      : { _tag: "link", event: classified(""), code };
  }
  if (text.length === 0) return ignored("empty");
  return { _tag: "message", event: classified(text) };
}

/** Replies always go to the thread root, never to the reply that triggered them. */
export function slackReplyAddress(
  event: SlackClassifiedMessage,
  connectionId: string,
): ChannelReplyAddress {
  return {
    kind: "slack",
    connectionId,
    teamId: event.teamId,
    channelId: event.channelId,
    rootTs: event.rootTs,
  };
}

/** What Slack told us about the sender. Never a source of permissions. */
export function slackActor(event: SlackClassifiedMessage): ChannelActorRef {
  return { externalActorId: event.userId };
}

const SlackBlockActions = Schema.Struct({
  type: Schema.Literal("block_actions"),
  team: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ id: Schema.String }),
  channel: Schema.Struct({ id: Schema.String }),
  message: Schema.optionalKey(
    Schema.Struct({
      ts: Schema.optionalKey(Schema.String),
      thread_ts: Schema.optionalKey(Schema.String),
    }),
  ),
  container: Schema.optionalKey(
    Schema.Struct({
      thread_ts: Schema.optionalKey(Schema.String),
    }),
  ),
  actions: Schema.Array(
    Schema.Struct({
      action_id: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.String),
      action_ts: Schema.optionalKey(Schema.String),
    }),
  ),
});
const decodeBlockActions = Schema.decodeUnknownOption(SlackBlockActions);

const slackTsOf = (value: string | undefined): string | undefined =>
  value !== undefined && isSlackTs(value) ? value : undefined;

/**
 * A Socket Mode `interactive` payload. `block_actions` on a choice button becomes the same
 * kind of message an event would. Other interactive payloads are acknowledged and ignored.
 */
export function classifySlackInteraction(
  body: unknown,
  config: SlackClassifierConfig,
): SlackEventClassification {
  const decoded = decodeBlockActions(body);
  if (Option.isNone(decoded)) return ignored("unsupported_event");
  const payload = decoded.value;
  const { id: teamId } = payload.team;
  if (!isSlackId(teamId)) return ignored("malformed");
  if (teamId !== config.teamId) return ignored("team_mismatch");
  const userId = payload.user.id;
  if (!isSlackId(userId)) return ignored("missing_user");
  if (userId === config.botUserId) return ignored("own_bot");
  const channelId = payload.channel.id;
  if (!isSlackId(channelId)) return ignored("malformed");
  const isDirectMessage = channelId.startsWith("D");
  if (!isDirectMessage && !config.allowedChannelIds.has(channelId)) {
    return ignored("channel_not_allowed");
  }
  const action = payload.actions.find(
    (candidate) =>
      candidate.action_id !== undefined &&
      isSlackChoiceActionId(candidate.action_id) &&
      candidate.value !== undefined &&
      candidate.value.trim() !== "" &&
      candidate.value.length <= 2000 &&
      slackTsOf(candidate.action_ts) !== undefined,
  );
  if (
    action === undefined ||
    action.action_id === undefined ||
    action.value === undefined ||
    action.action_ts === undefined
  ) {
    return ignored("unsupported_event");
  }
  const actionTs = slackTsOf(action.action_ts);
  const rootTs =
    slackTsOf(payload.message?.thread_ts) ??
    slackTsOf(payload.container?.thread_ts) ??
    slackTsOf(payload.message?.ts);
  if (actionTs === undefined || rootTs === undefined) return ignored("malformed");
  const event: SlackClassifiedMessage = {
    teamId,
    channelId,
    surface: isDirectMessage ? "dm" : "mention",
    userId,
    ts: actionTs,
    rootTs,
    isReply: rootTs !== actionTs,
    eventId: "ia:" + actionTs,
    dedupeKey: `${teamId}:ia:${channelId}:${rootTs}:${userId}:${action.action_id}:${actionTs}`,
    conversationKey: `${teamId}:${channelId}:${rootTs}`,
    text: action.value,
  };
  return { _tag: "message", event };
}

export function toSlackInboundMessage(
  event: SlackClassifiedMessage,
  input: { readonly connectionId: string; readonly receivedAt: string },
): ChannelInboundMessage {
  return {
    kind: "slack",
    connectionId: input.connectionId,
    conversationKey: event.conversationKey,
    externalMessageId: event.ts,
    idempotencyKey: event.dedupeKey,
    actor: slackActor(event),
    replyAddress: slackReplyAddress(event, input.connectionId),
    text: event.text,
    attachments: [],
    receivedAt: input.receivedAt,
    intent: "message",
  };
}
