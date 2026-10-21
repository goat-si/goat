/**
 * Stable ids for channel records. Every id a retry could recreate derives from the record's
 * natural key, so replaying the same input, task, or delivery lands on the same row instead of
 * a duplicate.
 *
 * @module channelIds
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest keeps id derivation pure.
import * as NodeCrypto from "node:crypto";

import {
  type ChannelBindingId,
  type ChannelConversationId,
  type ChannelDeliveryId,
  type ChannelInboundMessage,
  type ChannelInputId,
  type ChannelKind,
  type ChannelQuestionId,
  type ChannelTaskEventId,
  type ChannelTaskId,
  CommandId,
  MessageId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";

const digest = (parts: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256").update(parts.join("\u0000")).digest("base64url").slice(0, 32);

const stableId = (prefix: string, parts: ReadonlyArray<string>) => prefix + ":" + digest(parts);

export const inputIdFor = (input: {
  readonly ownerId: string;
  readonly kind: ChannelKind;
  readonly connectionId: string;
  readonly idempotencyKey: string;
}) =>
  stableId("channel-input", [
    input.ownerId,
    input.kind,
    input.connectionId,
    input.idempotencyKey,
  ]) as ChannelInputId;

export const conversationIdFor = (input: {
  readonly ownerId: string;
  readonly kind: ChannelKind;
  readonly connectionId: string;
  readonly conversationKey: string;
}) =>
  stableId("channel-conversation", [
    input.ownerId,
    input.kind,
    input.connectionId,
    input.conversationKey,
  ]) as ChannelConversationId;

export const bindingIdFor = (conversationId: ChannelConversationId, replyAddressKey: string) =>
  stableId("channel-binding", [conversationId, replyAddressKey]) as ChannelBindingId;

/** The n-th task an input created. A re-run of the same decision gets the same ids. */
export const taskIdFor = (inputId: ChannelInputId, ordinal: number) =>
  stableId("channel-task", [inputId, String(ordinal)]) as ChannelTaskId;

export const taskEventIdFor = (taskId: ChannelTaskId, version: number) =>
  stableId("channel-task-event", [taskId, String(version)]) as ChannelTaskEventId;

export const questionIdFor = (taskId: ChannelTaskId, version: number) =>
  stableId("channel-question", [taskId, String(version)]) as ChannelQuestionId;

export const deliveryIdFor = (causeKey: string) =>
  stableId("channel-delivery", [causeKey]) as ChannelDeliveryId;

/** The launch of one task generation: the same command, thread, and message on every retry. */
export const workerLaunchIdsFor = (taskId: ChannelTaskId, generation: number) => ({
  commandId: CommandId.make(stableId("channel-launch", [taskId, String(generation)])),
  threadId: ThreadId.make(stableId("channel-worker", [taskId, String(generation)])),
  messageId: MessageId.make(stableId("channel-worker-message", [taskId, String(generation)])),
});

export const answerForwardIdsFor = (eventId: ChannelTaskEventId) => ({
  commandId: CommandId.make(stableId("channel-answer", [eventId])),
  messageId: MessageId.make(stableId("channel-answer-message", [eventId])),
});

/**
 * Stopping a task's worker and its subagents for one recorded stop; a replay stops once. A stop
 * the orchestrator refused for good is tried again under ids keyed by its attempt, so a retry is
 * a new command rather than the refused one replayed.
 */
export const stopIdsFor = (eventId: ChannelTaskEventId, attempt?: string) => {
  const key = attempt === undefined ? [eventId] : [eventId, attempt];
  return {
    interrupt: CommandId.make(stableId("channel-stop", key)),
    subagents: CommandId.make(stableId("channel-stop-subagents", [eventId])),
  };
};

/**
 * A follow-up sent to the worker already doing its work; a retried input sends it once. The
 * "queued" attempt is the second and last one, used only after the orchestrator rejected the
 * first, since a rejected command id is refused for good.
 */
export const turnSteerIdsFor = (inputId: ChannelInputId, attempt: "first" | "queued" = "first") => {
  const key = attempt === "first" ? [inputId] : [inputId, "queued"];
  return {
    commandId: CommandId.make(stableId("channel-steer", key)),
    messageId: MessageId.make(stableId("channel-steer-message", key)),
  };
};

/**
 * The report binding of one task generation on another machine. The remote stores it before it
 * creates the thread and refuses a second binding with the same id, so relaunching a generation
 * can never start a second remote thread.
 */
export const remoteCorrelationFor = (taskId: ChannelTaskId, generation: number) =>
  stableId("channel-remote", [taskId, String(generation)]);

/** The remote worktree branch for one task generation. */
export const remoteBranchFor = (taskId: ChannelTaskId, generation: number) =>
  "goat/channel-" + digest([taskId]).slice(0, 8).toLowerCase() + "-g" + generation;

/** The ledger event that imports one remote report; a re-imported report finds it. */
export const remoteReportEventIdFor = (correlationId: string, sequence: number) =>
  stableId("channel-remote-report", [correlationId, String(sequence)]) as ChannelTaskEventId;

/**
 * Timeline ids stay fixed per record in one bot thread; command ids also carry what changed. A
 * record replayed into a replacement bot gets its own ids there.
 */
export const timelineIdsFor = (threadId: ThreadId, recordKey: string, revision: string) => ({
  messageId: MessageId.make(stableId("channel-message", [threadId, recordKey])),
  turnItemId: TurnItemId.make(stableId("channel-item", [threadId, recordKey])),
  commandId: CommandId.make(stableId("channel-record", [threadId, recordKey, revision])),
});

/** The owner's bot, or the bot that replaces a deleted one: every caller lands on one thread. */
export const botLaunchIdsFor = (ownerId: string, replacing?: ThreadId) => {
  const parts = replacing === undefined ? [ownerId] : [ownerId, replacing];
  return {
    commandId: CommandId.make(stableId("channel-bot-launch", parts)),
    threadId: ThreadId.make(stableId("channel-bot", parts)),
  };
};

/** Switching a stored bot thread to full access, once per thread and moment it was needed. */
export const botFullAccessCommandIdFor = (threadId: ThreadId, at: string) =>
  CommandId.make(stableId("channel-bot-full-access", [threadId, at]));

/** What makes two inputs under one idempotency key the same input. */
export const contentHashFor = (message: ChannelInboundMessage) =>
  digest([
    message.text,
    message.intent,
    message.taskId ?? "",
    message.questionId ?? "",
    message.conversationKey,
    ...message.attachments.map((attachment) => attachment.id),
  ]);

export const linkCodeHashFor = (connectionId: string, code: string) =>
  digest(["link-code", connectionId, code.trim()]);
