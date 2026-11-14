import * as Schema from "effect/Schema";

import { BotColor, BotId, BotProfile, BotRole } from "./botProfile.ts";
import { AuthEnvironmentScopes } from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ChannelChildWork,
  ChannelChildWorkId,
  ChannelChildWorkState,
  GoatBotWorkKind,
} from "./channelChildWork.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import {
  ChannelActorRef,
  ChannelBindingId,
  ChannelConversationId,
  ChannelDeliveryErrorCode,
  ChannelDeliveryId,
  ChannelInputId,
  ChannelKind,
  ChannelQuestionId,
  ChannelReceptionId,
  ChannelReplyAddress,
  ChannelTaskEventId,
  ChannelTaskId,
} from "./channelCommon.ts";
import { ChannelBotRef, ChannelTask, ChannelTaskChip, ChannelTaskStatus } from "./channelLedger.ts";
import { ChannelSkillProposal } from "./channelSkillProposal.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { GoatBotHomeClaim } from "./settings.ts";

/**
 * The one door channel input comes through. Every transport (the GOAT bot, Slack, MCP agents)
 * hands the gateway the same message shape and gets the same durable receipt back. The receipt
 * confirms storage only; the reply arrives later through the conversation's reply address.
 */

/**
 * A normalized inbound message. `kind`, `connectionId`, `actor`, and `replyAddress` are
 * checked against the caller's authenticated context; a caller cannot pick them freely.
 */
export const ChannelInboundMessage = Schema.Struct({
  kind: ChannelKind,
  connectionId: TrimmedNonEmptyString,
  conversationKey: TrimmedNonEmptyString,
  externalMessageId: TrimmedNonEmptyString,
  /** Scoped per owner, kind, and connection. The same key with different content is rejected. */
  idempotencyKey: TrimmedNonEmptyString,
  actor: ChannelActorRef,
  replyAddress: ChannelReplyAddress,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  receivedAt: IsoDateTime,
  intent: Schema.Literals(["message", "report", "answer"]),
  taskId: Schema.optional(ChannelTaskId),
  questionId: Schema.optional(ChannelQuestionId),
});
export type ChannelInboundMessage = typeof ChannelInboundMessage.Type;

export const ChannelIngestInput = ChannelInboundMessage;
export type ChannelIngestInput = ChannelInboundMessage;

/**
 * `rejected` is a result, not an error: input from an unlinked account comes back rejected,
 * with a link notice already committed for delivery to its reply address.
 */
export const ChannelIngestState = Schema.Literals([
  "accepted",
  "processing",
  "replied",
  "rejected",
]);
export type ChannelIngestState = typeof ChannelIngestState.Type;

export const ChannelIngestResult = Schema.Struct({
  inputId: ChannelInputId,
  conversationId: ChannelConversationId,
  bindingId: ChannelBindingId,
  receptionId: Schema.optional(ChannelReceptionId),
  /** True when this idempotency key was already stored; nothing ran twice. */
  duplicate: Schema.Boolean,
  state: ChannelIngestState,
  acceptedAt: IsoDateTime,
  /** Empty until reception decides; read them later with getInput. */
  taskIds: Schema.Array(ChannelTaskId),
  /** For GOAT bot input, the orchestration sequence that recorded the user message. */
  timelineSequence: Schema.optional(Schema.Number),
});
export type ChannelIngestResult = typeof ChannelIngestResult.Type;

export const ChannelInputSnapshot = Schema.Struct({
  ...ChannelIngestResult.fields,
  readAt: Schema.optional(IsoDateTime),
  reply: Schema.optional(
    Schema.Struct({
      text: Schema.String,
      sentAt: Schema.optional(IsoDateTime),
      inReplyToInputId: ChannelInputId,
    }),
  ),
  failure: Schema.optional(
    Schema.Struct({
      reason: TrimmedNonEmptyString,
      message: Schema.String,
    }),
  ),
});
export type ChannelInputSnapshot = typeof ChannelInputSnapshot.Type;

export const ChannelOutboundKind = Schema.Literals([
  "receipt",
  "result",
  "question",
  "failure",
  "task_chip",
]);
export type ChannelOutboundKind = typeof ChannelOutboundKind.Type;

/** One delivery to a transport. Delivery is at least once; `deliveryId` stays the same on retry. */
export const ChannelOutboundMessage = Schema.Struct({
  deliveryId: ChannelDeliveryId,
  destination: ChannelReplyAddress,
  kind: ChannelOutboundKind,
  text: Schema.String,
  inReplyToInputId: Schema.optional(ChannelInputId),
  taskId: Schema.optional(ChannelTaskId),
  taskVersion: Schema.optional(PositiveInt),
  /** The attempt of the task this message speaks for; servers before it omit it. */
  taskGeneration: Schema.optional(PositiveInt),
  chip: Schema.optional(ChannelTaskChip),
  /** The original requester to tag, such as a Slack user id. */
  mentionActorId: Schema.optional(TrimmedNonEmptyString),
  /** Answers a question offers; transports without buttons list them in the text. */
  options: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  questionId: Schema.optional(ChannelQuestionId),
  /**
   * Progress before the answer, such as a milestone or where the work runs. Channels that keep
   * every message send only one such message; anything else always goes.
   */
  interim: Schema.optional(Schema.Literal(true)),
  /** See ChannelMessageMeta.questionKind. */
  questionKind: Schema.optional(Schema.Literal("task")),
  /**
   * Reception's committed decision about a person's answer from a task question's card, for the
   * GOAT bot to record on that person's message (ChannelMessageMeta.answersQuestionId).
   */
  personAnswer: Schema.optional(
    Schema.Struct({ answersQuestionId: Schema.NullOr(ChannelQuestionId) }),
  ),
});
export type ChannelOutboundMessage = typeof ChannelOutboundMessage.Type;

export const ChannelDeliveryReceipt = Schema.Struct({
  deliveryId: ChannelDeliveryId,
  acceptedAt: IsoDateTime,
  externalMessageId: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelDeliveryReceipt = typeof ChannelDeliveryReceipt.Type;

/**
 * A worker's report on its assigned task. The sender's identity and thread come from the MCP
 * invocation, not from this payload, and must match the task's current assignment.
 */
export const ChannelTaskReportInput = Schema.Struct({
  taskId: ChannelTaskId,
  eventId: ChannelTaskEventId,
  generation: PositiveInt,
  status: Schema.Literals(["running", "waiting_input", "completed", "failed"]),
  summary: TrimmedNonEmptyString,
  milestone: Schema.optional(Schema.Boolean),
  question: Schema.optional(TrimmedNonEmptyString),
  /** Only on a completed report; see ChannelSkillProposal. */
  skillProposal: Schema.optional(ChannelSkillProposal),
});
export type ChannelTaskReportInput = typeof ChannelTaskReportInput.Type;

/** Creates a one-time code that links an external account to this server's owner. */
export const ChannelIdentityLinkCreateInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  runtimeModeCeiling: RuntimeMode,
  grantedScopes: Schema.optional(AuthEnvironmentScopes),
  expiresInSeconds: Schema.optional(PositiveInt),
});
export type ChannelIdentityLinkCreateInput = typeof ChannelIdentityLinkCreateInput.Type;

export const ChannelIdentityLinkCreateResult = Schema.Struct({
  code: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ChannelIdentityLinkCreateResult = typeof ChannelIdentityLinkCreateResult.Type;

/**
 * Sent by a transport when an external user replies with a link code; never stored as a message.
 * The gateway commits a success or failure notice to `replyAddress`, deduplicated by
 * `idempotencyKey`, before it returns.
 */
export const ChannelIdentityLinkConsumeInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  externalActorId: TrimmedNonEmptyString,
  code: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  replyAddress: ChannelReplyAddress,
});
export type ChannelIdentityLinkConsumeInput = typeof ChannelIdentityLinkConsumeInput.Type;

export const ChannelIdentityLinkConsumeResult = Schema.Struct({
  principalId: TrimmedNonEmptyString,
  linkedAt: IsoDateTime,
});
export type ChannelIdentityLinkConsumeResult = typeof ChannelIdentityLinkConsumeResult.Type;

export const ChannelNoticeKind = Schema.Literals(["link_help", "link_invalid"]);
export type ChannelNoticeKind = typeof ChannelNoticeKind.Type;

/** A fixed notice a transport asks for, such as help for a `link` command without a code. */
export const ChannelNoticeInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  idempotencyKey: TrimmedNonEmptyString,
  replyAddress: ChannelReplyAddress,
  actor: ChannelActorRef,
  notice: ChannelNoticeKind,
});
export type ChannelNoticeInput = typeof ChannelNoticeInput.Type;

/** The notice is committed for delivery; `duplicate` means this key was already handled. */
export const ChannelNoticeReceipt = Schema.Struct({
  deliveryId: ChannelDeliveryId,
  duplicate: Schema.Boolean,
});
export type ChannelNoticeReceipt = typeof ChannelNoticeReceipt.Type;

/** Removes a link. Tasks keep the requester snapshot they were created with. */
export const ChannelIdentityUnlinkInput = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  externalActorId: TrimmedNonEmptyString,
});
export type ChannelIdentityUnlinkInput = typeof ChannelIdentityUnlinkInput.Type;

const CHANNEL_GATEWAY_FAILURE_MESSAGES = {
  identity_unlinked: "This account is not linked to GOAT yet.",
  forbidden: "This request is not allowed for this sender.",
  invalid_input: "The channel message is not valid.",
  idempotency_conflict: "A different message was already stored under this idempotency key.",
  adapter_unavailable: "This channel is not available on this server.",
  legacy_active: "The previous global agent is still running. Stop it before switching.",
  persistence_failed: "Could not store the channel message.",
  delivery_failed: "Could not deliver the channel message.",
  not_found: "The requested channel record does not exist.",
  task_not_found: "The requested channel task does not exist.",
  not_home: "GOAT Bot runs on another machine in this cluster.",
  bot_busy: "This bot still has work in progress.",
  bot_limit: "This owner already has the most bots allowed.",
  stream_unavailable: "Task changes are not streaming here; read again when you return.",
} as const;

export const ChannelGatewayErrorReason = Schema.Literals(
  Object.keys(CHANNEL_GATEWAY_FAILURE_MESSAGES) as Array<
    keyof typeof CHANNEL_GATEWAY_FAILURE_MESSAGES
  >,
);
export type ChannelGatewayErrorReason = typeof ChannelGatewayErrorReason.Type;

/**
 * A channel operation failed. The message is safe to show users and agents: it never contains
 * channel message text, tokens, or link codes. There is no `cause` field because a cause would
 * be encoded onto the wire; the server logs it before mapping to this error.
 */
export class ChannelGatewayError extends Schema.TaggedError<ChannelGatewayError>()(
  "ChannelGatewayError",
  {
    reason: ChannelGatewayErrorReason,
    attachmentProblem: Schema.optionalKey(Schema.Literal("expired")),
    /** Seconds the caller should wait before retrying, when the transport said so. */
    retryAfterSeconds: Schema.optionalKey(PositiveInt),
    /**
     * For `delivery_failed`: `not_sent` when the channel certainly did not get the message,
     * `unknown` when it may have (a timeout). The outbox records unknown as ambiguous.
     */
    deliveryOutcome: Schema.optionalKey(Schema.Literals(["not_sent", "unknown"])),
    deliveryErrorCode: Schema.optionalKey(ChannelDeliveryErrorCode),
    /** For `not_home`: the environment the cluster's GOAT Bot home claim names. */
    homeEnvironmentId: Schema.optionalKey(EnvironmentId),
  },
) {
  override get message(): string {
    return CHANNEL_GATEWAY_FAILURE_MESSAGES[this.reason];
  }
}

/** Resolves the canonical GOAT bot, adopting a stopped legacy global agent when one is given. */
export const ChannelEnsureBotInput = Schema.Struct({
  candidateThreadId: Schema.optional(ThreadId),
});
export type ChannelEnsureBotInput = typeof ChannelEnsureBotInput.Type;

export const ChannelEnsureBotResult = ChannelBotRef;
export type ChannelEnsureBotResult = ChannelBotRef;

/**
 * What a client shows about the GOAT bot without opening it: which thread is the bot (null until
 * an `ensureBot` creates one; this never creates it) and how many tasks, from any channel, wait on
 * a person: an open question, or a worker thread that needs an answer, approval, sign-in or resume.
 * Tasks already waiting when the bot thread was last visited (`thread.visit`) count as read.
 */
export const ChannelGetBotStatusInput = Schema.Struct({ botId: Schema.optionalKey(BotId) });
export type ChannelGetBotStatusInput = typeof ChannelGetBotStatusInput.Type;

export const ChannelGetBotStatusResult = Schema.Struct({
  bot: Schema.NullOr(ChannelBotRef),
  waitingCount: NonNegativeInt,
  /**
   * The newest message the bot's main chat shows, as one plain line, for a roster row: a task's
   * own messages stay out as they stay in its view, and a message of only files reads as their
   * names. Older servers sent the raw text of any message. Absent from servers before it existed
   * and while the conversation is empty.
   */
  latest: Schema.optionalKey(
    Schema.Struct({
      text: Schema.String,
      at: IsoDateTime,
      author: Schema.Literals(["bot", "person"]),
    }),
  ),
  /**
   * Whether the bot's tasks are going, for a roster row. `active`: a task is received,
   * dispatching or running and the chat would not say it waits on the person; an automatic
   * usage-limit pause is not active. Absent from servers before it existed.
   */
  tasks: Schema.optionalKey(Schema.Struct({ active: Schema.Boolean })),
});
export type ChannelGetBotStatusResult = typeof ChannelGetBotStatusResult.Type;

/**
 * One thing a bot waits on the person for, across all of the owner's bots: an open question, an
 * approval, a sign-in or a usage-limit pause, with the words its card shows. `taskId` (with
 * `questionId` or `requestId` when there is one) is the card or task view it opens.
 */
export const ChannelOpenAsk = Schema.Struct({
  botId: BotId,
  taskId: ChannelTaskId,
  kind: Schema.Literals(["question", "approval", "sign_in", "usage_limit"]),
  text: Schema.String,
  askedAt: IsoDateTime,
  questionId: Schema.optionalKey(ChannelQuestionId),
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ChannelOpenAsk = typeof ChannelOpenAsk.Type;
/** How many asks a read returns unless it asks for more. */
export const CHANNEL_OPEN_ASKS_DEFAULT_LIMIT = 50;
export const CHANNEL_OPEN_ASKS_MAX_LIMIT = 500;
/** Servers with the goatBotOpenAsksLimit capability honour `limit`; older ones return the default. */
export const ChannelListOpenAsksInput = Schema.Struct({
  limit: Schema.optionalKey(
    PositiveInt.check(Schema.isLessThanOrEqualTo(CHANNEL_OPEN_ASKS_MAX_LIMIT)),
  ),
});
export type ChannelListOpenAsksInput = typeof ChannelListOpenAsksInput.Type;
/** The newest asks; `total` counts them all, and `truncated` says it is a lower bound. */
export const ChannelListOpenAsksResult = Schema.Struct({
  asks: Schema.Array(ChannelOpenAsk),
  total: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ChannelListOpenAsksResult = typeof ChannelListOpenAsksResult.Type;
export const ChannelSubscribeTaskChangesInput = Schema.Struct({});
export type ChannelSubscribeTaskChangesInput = typeof ChannelSubscribeTaskChangesInput.Type;
/**
 * Revision 0 when the subscription starts, then a higher one after each change to the owner's
 * tasks or bots (several close together arrive as one). It says only "read again".
 */
export const ChannelTaskChangesEvent = Schema.Struct({ revision: NonNegativeInt });
export type ChannelTaskChangesEvent = typeof ChannelTaskChangesEvent.Type;

/** Main first; never creates a bot. Deleted members only when asked for. */
export const ChannelListBotsInput = Schema.Struct({
  includeDeleted: Schema.optionalKey(Schema.Boolean),
});
export const ChannelListBotsResult = Schema.Struct({ bots: Schema.Array(BotProfile) });
export type ChannelListBotsInput = typeof ChannelListBotsInput.Type;
export type ChannelListBotsResult = typeof ChannelListBotsResult.Type;

/** A bot as agents see it: who it is and its conversation, nothing else a person set. */
export const ChannelBotSummary = Schema.Struct({
  botId: BotId,
  role: BotRole,
  name: BotProfile.fields.name,
  purpose: BotProfile.fields.purpose,
  hidden: Schema.Boolean,
  sessionThreadId: ThreadId,
});
export const ChannelBotListResult = Schema.Struct({ bots: Schema.Array(ChannelBotSummary) });
export type ChannelBotListResult = typeof ChannelBotListResult.Type;

/**
 * Changes only the keys sent; null clears an avatar, a member's model or its color. The main bot
 * refuses a model (a setting) and a color. A model needs `goatBotMemberModelEdit`, a color
 * `goatBotProfileColor`; older servers drop either key.
 */
export const ChannelUpdateBotInput = Schema.Struct({
  botId: BotId,
  name: Schema.optionalKey(BotProfile.fields.name),
  avatar: Schema.optionalKey(BotProfile.fields.avatar),
  purpose: Schema.optionalKey(BotProfile.fields.purpose),
  defaultModelSelection: Schema.optionalKey(BotProfile.fields.defaultModelSelection),
  color: Schema.optionalKey(Schema.NullOr(BotColor)),
});
export const ChannelUpdateBotResult = Schema.Struct({ bot: BotProfile });

/** A member bot with its own conversation. A retry with the same clientRequestId returns it. */
export const ChannelCreateBotInput = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  purpose: BotProfile.fields.purpose,
  defaultModelSelection: BotProfile.fields.defaultModelSelection,
  /** Read by servers with `goatBotProfileColor`; absent leaves the bot neutral. */
  color: Schema.optionalKey(BotColor),
});
export type ChannelCreateBotInput = typeof ChannelCreateBotInput.Type;
export const ChannelSetBotHiddenInput = Schema.Struct({ botId: BotId, hidden: Schema.Boolean });
export type ChannelSetBotHiddenInput = typeof ChannelSetBotHiddenInput.Type;
/** Refused with bot_busy while the bot has open work; its thread is archived, not removed. */
export const ChannelDeleteBotInput = Schema.Struct({ botId: BotId });
export type ChannelDeleteBotInput = typeof ChannelDeleteBotInput.Type;
export const ChannelRestoreBotInput = Schema.Struct({ botId: BotId });
export type ChannelRestoreBotInput = typeof ChannelRestoreBotInput.Type;
export const ChannelBotResult = Schema.Struct({ bot: BotProfile });
export type ChannelBotResult = typeof ChannelBotResult.Type;
export type ChannelUpdateBotInput = typeof ChannelUpdateBotInput.Type;
export type ChannelUpdateBotResult = typeof ChannelUpdateBotResult.Type;

export const ChannelTaskView = Schema.Struct({
  taskId: ChannelTaskId,
  pinnedAt: Schema.NullOr(IsoDateTime),
  doneAt: Schema.NullOr(IsoDateTime),
  readThrough: Schema.NullOr(IsoDateTime),
});
export type ChannelTaskView = typeof ChannelTaskView.Type;

export const ChannelUpdateTaskViewInput = Schema.Struct({
  taskId: ChannelTaskId,
  pinned: Schema.optional(Schema.Boolean),
  done: Schema.optional(Schema.Boolean),
  readThrough: Schema.optional(IsoDateTime),
});
export type ChannelUpdateTaskViewInput = typeof ChannelUpdateTaskViewInput.Type;

export const BotThreadRow = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("task"),
    task: Schema.Struct({
      taskId: ChannelTaskId,
      title: TrimmedNonEmptyString,
      status: ChannelTaskStatus,
      updatedAt: IsoDateTime,
      completedAt: Schema.optional(IsoDateTime),
      /** The attempt this row shows; absent means the first. */
      generation: Schema.optional(PositiveInt),
    }),
    view: ChannelTaskView,
    lastActivityAt: IsoDateTime,
    unread: Schema.Boolean,
    mainMessagesSinceQuiet: NonNegativeInt,
    /** The task's worker thread on this machine, which this row opens. */
    worker: Schema.optional(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
  }),
  Schema.Struct({
    kind: Schema.Literal("coding"),
    taskId: ChannelTaskId,
    environmentId: EnvironmentId,
    threadId: ThreadId,
    title: Schema.optional(Schema.String),
    state: ChannelChildWorkState,
    lastActivityAt: IsoDateTime,
    /** Absent when the launch recorded none and its project does not say. */
    workKind: Schema.optional(GoatBotWorkKind),
  }),
]);
export type BotThreadRow = typeof BotThreadRow.Type;
/**
 * A thread the bot launched on another machine over SSH. It is not a row: its host is this
 * machine's SSH alias, so only the destination's own environment id, once the launch was
 * acknowledged, can open it from a client.
 */
export const BotRemoteWork = Schema.Struct({
  childWorkId: ChannelChildWorkId,
  taskId: ChannelTaskId,
  /** The bot thread that launched it, which the destination records as its launcher. */
  callerThreadId: ThreadId,
  host: TrimmedNonEmptyString,
  state: ChannelChildWorkState,
  lastActivityAt: IsoDateTime,
  threadId: Schema.optional(ThreadId),
  environmentId: Schema.optional(EnvironmentId),
  workKind: Schema.optional(GoatBotWorkKind),
});
export type BotRemoteWork = typeof BotRemoteWork.Type;
/** A history page's tasks, and the launched threads it lists per task, newest first. */
export const BotTaskSummary = Schema.Struct({
  taskId: ChannelTaskId,
  title: TrimmedNonEmptyString,
  titleTruncated: Schema.optionalKey(Schema.Boolean),
  status: ChannelTaskStatus,
  updatedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
  generation: Schema.optional(PositiveInt),
});
export const BotTaskRow = Schema.Struct({
  kind: Schema.Literal("task"),
  task: BotTaskSummary,
  view: ChannelTaskView,
  lastActivityAt: IsoDateTime,
  unread: Schema.Boolean,
  mainMessagesSinceQuiet: NonNegativeInt,
  worker: Schema.optional(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
});
export const BotCodingRow = Schema.Struct({
  kind: Schema.Literal("coding"),
  taskId: ChannelTaskId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.optional(Schema.String),
  titleTruncated: Schema.optionalKey(Schema.Boolean),
  state: ChannelChildWorkState,
  lastActivityAt: IsoDateTime,
  workKind: Schema.optional(GoatBotWorkKind),
});
export const BotWorkResult = Schema.Struct({
  task: Schema.Union([
    Schema.Struct({ state: Schema.Literal("known"), row: BotTaskRow }),
    Schema.Struct({
      state: Schema.Literal("unavailable"),
      task: BotTaskSummary,
      worker: Schema.optional(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
    }),
  ]),
  codingRows: Schema.Array(BotCodingRow),
  remoteWork: Schema.Array(BotRemoteWork),
  launchesTruncated: Schema.Boolean,
  partial: Schema.Boolean,
});
export type BotWorkResult = typeof BotWorkResult.Type;
export const ChannelGetBotTaskInput = Schema.Struct({ taskId: ChannelTaskId, botId: BotId });
export type ChannelGetBotTaskInput = typeof ChannelGetBotTaskInput.Type;
export const ChannelSearchBotTasksInput = Schema.Struct({
  botId: BotId,
  query: TrimmedNonEmptyString.check(
    Schema.isMaxLength(256),
    Schema.makeFilter((value) => !value.includes("\0"), {
      expected: "a search query without NUL characters",
    }),
  ),
  cursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  limit: Schema.optionalKey(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export type ChannelSearchBotTasksInput = typeof ChannelSearchBotTasksInput.Type;
export const ChannelSearchBotTasksResult = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      taskId: ChannelTaskId,
      title: TrimmedNonEmptyString,
      titleTruncated: Schema.optionalKey(Schema.Boolean),
      createdAt: IsoDateTime,
    }),
  ).check(Schema.isMaxLength(50)),
  nextCursor: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  partial: Schema.optionalKey(Schema.Boolean),
  endedEarly: Schema.optionalKey(Schema.Boolean),
});
export type ChannelSearchBotTasksResult = typeof ChannelSearchBotTasksResult.Type;
export const CHANNEL_BOT_THREADS_HISTORY_LIMIT = 50;
export const CHANNEL_BOT_THREADS_HISTORY_LAUNCHES = 20;
export const CHANNEL_BOT_THREADS_CURSOR_MAX_LENGTH = 512;
/** Opaque and bound to one owner and bot; a server refuses one that is not its own. */
export const ChannelBotThreadsCursor = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHANNEL_BOT_THREADS_CURSOR_MAX_LENGTH),
);
export const ChannelListBotThreadsInput = Schema.Struct({
  botId: Schema.optionalKey(BotId),
  /**
   * Read by servers with `goatBotTaskThreadsPaged`: instead of the current list, one page of
   * every task of the bot by creation, newest first, from the cursor the previous page returned.
   * Older servers drop the key and answer the current list.
   */
  history: Schema.optionalKey(
    Schema.Struct({ cursor: Schema.optionalKey(ChannelBotThreadsCursor) }),
  ),
});
export type ChannelListBotThreadsInput = typeof ChannelListBotThreadsInput.Type;
export const ChannelListBotThreadsResult = Schema.Struct({
  rows: Schema.Array(BotThreadRow),
  /** History pages carry 0: the bot's count belongs to the current list. */
  mainMessageCount: NonNegativeInt,
  /** Absent from servers before it; clients read that as none. */
  remoteWork: Schema.optional(Schema.Array(BotRemoteWork)),
  /**
   * Present when the input asked for history; an answer without it came from a server that does
   * not walk history. A history row's mainMessagesSinceQuiet is the exact count capped at 10, the
   * only value clients compare it with, so a ">= 10" decision matches the current list's.
   */
  history: Schema.optionalKey(
    Schema.Struct({
      /**
       * The next page's start; absent once the walk reached the bot's oldest task. One request
       * examines at most 500 tasks plus one lookahead, so a page can be short or empty and still
       * carry it: keep reading until it is absent.
       */
      nextCursor: Schema.optionalKey(ChannelBotThreadsCursor),
      /** Tasks that launched more threads than this page lists; the rest stay in Threads. */
      launchesTruncated: Schema.optionalKey(Schema.Array(ChannelTaskId)),
      /** The walk cannot go on: the next task's stored id cannot be named in a cursor. */
      endedEarly: Schema.optionalKey(Schema.Boolean),
      /**
       * This page left out stored tasks, launches or task views it could not read; a row whose
       * view was unreadable shows the empty view. The walk is not a complete account of the bot.
       */
      partial: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type ChannelListBotThreadsResult = typeof ChannelListBotThreadsResult.Type;

export const CHANNEL_LIST_CHILD_WORK_MAX_TASKS = 50;
export const ChannelListChildWorkInput = Schema.Struct({
  taskIds: Schema.Array(ChannelTaskId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CHANNEL_LIST_CHILD_WORK_MAX_TASKS),
  ),
});
export type ChannelListChildWorkInput = typeof ChannelListChildWorkInput.Type;
export const ChannelChildWorkGroup = Schema.Struct({
  taskId: ChannelTaskId,
  children: Schema.Array(ChannelChildWork),
  truncated: Schema.Boolean,
});
export type ChannelChildWorkGroup = typeof ChannelChildWorkGroup.Type;
export const ChannelListChildWorkResult = Schema.Struct({
  groups: Schema.Array(ChannelChildWorkGroup),
});
export type ChannelListChildWorkResult = typeof ChannelListChildWorkResult.Type;

export const ChannelGetTaskInput = Schema.Struct({ taskId: ChannelTaskId });
export type ChannelGetTaskInput = typeof ChannelGetTaskInput.Type;

export const CHANNEL_LIST_TASKS_MAX_LIMIT = 100;

export const ChannelListTasksInput = Schema.Struct({
  status: Schema.optional(Schema.Array(ChannelTaskStatus)),
  limit: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(CHANNEL_LIST_TASKS_MAX_LIMIT)),
  ),
  cursor: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelListTasksInput = typeof ChannelListTasksInput.Type;
/** The client's task list, which can keep to one bot; agents list through ChannelListTasksInput. */
export const ChannelListTasksRpcInput = Schema.Struct({
  ...ChannelListTasksInput.fields,
  botId: Schema.optionalKey(BotId),
});
export type ChannelListTasksRpcInput = typeof ChannelListTasksRpcInput.Type;

export const ChannelListTasksResult = Schema.Struct({
  tasks: Schema.Array(ChannelTask),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelListTasksResult = typeof ChannelListTasksResult.Type;

export const ChannelTaskMoveInput = Schema.Struct({
  taskId: ChannelTaskId,
  host: TrimmedNonEmptyString,
});
export type ChannelTaskMoveInput = typeof ChannelTaskMoveInput.Type;

export const ChannelTaskMoveResult = Schema.Struct({
  taskId: ChannelTaskId,
  generation: PositiveInt,
  host: TrimmedNonEmptyString,
  fromHost: TrimmedNonEmptyString,
  replicaCapturedAt: IsoDateTime,
});
export type ChannelTaskMoveResult = typeof ChannelTaskMoveResult.Type;

export const ChannelRetryTaskInput = Schema.Struct({
  taskId: ChannelTaskId,
  /** One per tap; resending it after a lost reply returns the first result. */
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ChannelRetryTaskInput = typeof ChannelRetryTaskInput.Type;

/** Why a person's retry did not start. Clients turn each into their own copy. */
export const ChannelTaskRetryRefusal = Schema.Literals([
  "not_finished",
  "completed",
  "elsewhere",
  "still_running",
  "not_retryable",
  "bot_inactive",
]);
export type ChannelTaskRetryRefusal = typeof ChannelTaskRetryRefusal.Type;

export const ChannelRetryTaskResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("started"),
    taskId: ChannelTaskId,
    generation: PositiveInt,
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    taskId: ChannelTaskId,
    reason: ChannelTaskRetryRefusal,
  }),
]);
export type ChannelRetryTaskResult = typeof ChannelRetryTaskResult.Type;

export const ChannelGetInputInput = Schema.Struct({ inputId: ChannelInputId });
export type ChannelGetInputInput = typeof ChannelGetInputInput.Type;

/** Where GOAT Bot lives, as this server's settings record it. */
export const ChannelBotHomeStatus = Schema.Struct({
  /** The winning claim this server holds; null until some client or agent claims a home. */
  home: Schema.NullOr(GoatBotHomeClaim),
  /** This server's environment. */
  environmentId: EnvironmentId,
  /** Whether this server may run GOAT Bot: it is the home, or no home is claimed yet. */
  isHome: Schema.Boolean,
});
export type ChannelBotHomeStatus = typeof ChannelBotHomeStatus.Type;

export const ChannelBotHomeClaimResult = Schema.Struct({
  /** False when a newer claim, written meanwhile, still names another machine. */
  claimed: Schema.Boolean,
  home: GoatBotHomeClaim,
  environmentId: EnvironmentId,
});
export type ChannelBotHomeClaimResult = typeof ChannelBotHomeClaimResult.Type;

export const CHANNEL_GATEWAY_WS_METHODS = {
  ensureBot: "channel.ensureBot",
  getBotStatus: "channel.getBotStatus",
  listOpenAsks: "channel.listOpenAsks",
  subscribeTaskChanges: "channel.subscribeTaskChanges",
  listBots: "channel.listBots",
  updateBot: "channel.updateBot",
  createBot: "channel.createBot",
  setBotHidden: "channel.setBotHidden",
  deleteBot: "channel.deleteBot",
  restoreBot: "channel.restoreBot",
  listBotThreads: "channel.listBotThreads",
  listBotNotes: "channel.listBotNotes",
  listBotArtifacts: "channel.listBotArtifacts",
  readBotArtifact: "channel.readBotArtifact",
  listChildWork: "channel.listChildWork",
  updateTaskView: "channel.updateTaskView",
  retryTask: "channel.retryTask",
  ingest: "channel.ingest",
  getTask: "channel.getTask",
  getBotTask: "channel.getBotTask",
  searchBotTasks: "channel.searchBotTasks",
  listTasks: "channel.listTasks",
  getInput: "channel.getInput",
  createIdentityLink: "channel.createIdentityLink",
  unlinkIdentity: "channel.unlinkIdentity",
} as const;

/** Agent-facing channel tools. There is deliberately no tool that sends to an arbitrary channel. */
export const CHANNEL_MCP_TOOL_NAMES = {
  ingest: "channel_ingest",
  inputGet: "channel_input_get",
  taskGet: "channel_task_get",
  taskList: "channel_task_list",
  taskReport: "channel_task_report",
  taskMove: "channel_task_move",
  taskFollowUp: "channel_task_follow_up",
  taskStop: "channel_task_stop",
  taskAnswer: "channel_task_answer",
  botHome: "channel_bot_home",
  botHomeClaim: "channel_bot_home_claim",
} as const;
