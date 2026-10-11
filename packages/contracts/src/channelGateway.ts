import * as Schema from "effect/Schema";

import { AuthEnvironmentScopes } from "./auth.ts";
import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
import { RuntimeMode } from "./providerPolicy.ts";

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
  chip: Schema.optional(ChannelTaskChip),
  /** The original requester to tag, such as a Slack user id. */
  mentionActorId: Schema.optional(TrimmedNonEmptyString),
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
  question: Schema.optional(TrimmedNonEmptyString),
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
    /** Seconds the caller should wait before retrying, when the transport said so. */
    retryAfterSeconds: Schema.optionalKey(PositiveInt),
    /**
     * For `delivery_failed`: `not_sent` when the channel certainly did not get the message,
     * `unknown` when it may have (a timeout). The outbox records unknown as ambiguous.
     */
    deliveryOutcome: Schema.optionalKey(Schema.Literals(["not_sent", "unknown"])),
    deliveryErrorCode: Schema.optionalKey(ChannelDeliveryErrorCode),
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

export const ChannelListTasksResult = Schema.Struct({
  tasks: Schema.Array(ChannelTask),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelListTasksResult = typeof ChannelListTasksResult.Type;

export const ChannelGetInputInput = Schema.Struct({ inputId: ChannelInputId });
export type ChannelGetInputInput = typeof ChannelGetInputInput.Type;

export const CHANNEL_GATEWAY_WS_METHODS = {
  ensureBot: "channel.ensureBot",
  ingest: "channel.ingest",
  getTask: "channel.getTask",
  listTasks: "channel.listTasks",
  getInput: "channel.getInput",
  createIdentityLink: "channel.createIdentityLink",
  unlinkIdentity: "channel.unlinkIdentity",
} as const;

/** Agent-facing channel tools. There is deliberately no tool that sends to an arbitrary channel. */
export const CHANNEL_MCP_TOOL_NAMES = {
  ingest: "channel_ingest",
  taskGet: "channel_task_get",
  taskList: "channel_task_list",
  taskReport: "channel_task_report",
} as const;
