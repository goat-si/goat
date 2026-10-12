import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChannelConversationId,
  ChannelKind,
  ChannelQuestionId,
  ChannelRequester,
  ChannelTaskId,
} from "./channelCommon.ts";
import { ChannelDispatchTarget, ChannelTaskEventType, ChannelTaskStatus } from "./channelLedger.ts";

/**
 * Input and output of one reception pass: a short, tool-free text generation that answers a
 * channel message or turns a task event into words for the requester. It reads a bounded tail
 * of its own conversation and the related ledger tasks, never other conversations.
 */

export const ChannelReceptionMode = Schema.Literals(["input", "task_event"]);
export type ChannelReceptionMode = typeof ChannelReceptionMode.Type;

export const ChannelReceptionTailMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  at: IsoDateTime,
});
export type ChannelReceptionTailMessage = typeof ChannelReceptionTailMessage.Type;

export const ChannelReceptionTaskSummary = Schema.Struct({
  taskId: ChannelTaskId,
  title: TrimmedNonEmptyString,
  status: ChannelTaskStatus,
  resultSummary: Schema.optional(Schema.String),
  openQuestions: Schema.Array(
    Schema.Struct({ questionId: ChannelQuestionId, text: TrimmedNonEmptyString }),
  ),
});
export type ChannelReceptionTaskSummary = typeof ChannelReceptionTaskSummary.Type;

export const ChannelReceptionTaskEvent = Schema.Struct({
  taskId: ChannelTaskId,
  type: ChannelTaskEventType,
  summary: Schema.String,
});
export type ChannelReceptionTaskEvent = typeof ChannelReceptionTaskEvent.Type;

/** A place the requester may send work, offered to the model as a choice by id. */
export const ChannelReceptionTargetOption = Schema.Struct({
  projectId: ProjectId,
  label: TrimmedNonEmptyString,
});
export type ChannelReceptionTargetOption = typeof ChannelReceptionTargetOption.Type;

export const ChannelReceptionInput = Schema.Struct({
  mode: ChannelReceptionMode,
  conversationId: ChannelConversationId,
  originKind: ChannelKind,
  /** The message being answered, in `input` mode. */
  inputText: Schema.optional(Schema.String),
  /** The ledger change being reported, in `task_event` mode. */
  taskEvent: Schema.optional(ChannelReceptionTaskEvent),
  tail: Schema.Array(ChannelReceptionTailMessage),
  tasks: Schema.Array(ChannelReceptionTaskSummary),
  allowedTargets: Schema.Array(ChannelReceptionTargetOption),
  /** Other machines (SSH aliases) the requester may send work to. */
  allowedHosts: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  requester: ChannelRequester,
});
export type ChannelReceptionInput = typeof ChannelReceptionInput.Type;

/**
 * What the model decided. The ledger validates every id, target, and permission in it before
 * anything happens; the model cannot pick a task, project, or mode the requester may not use.
 */
export const ChannelReceptionAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create_task"),
    title: TrimmedNonEmptyString,
    instruction: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
    /** One of `allowedHosts`, when the person asked for another machine. */
    host: Schema.optional(TrimmedNonEmptyString),
    requestedTarget: Schema.optional(ChannelDispatchTarget),
  }),
  Schema.Struct({
    type: Schema.Literal("status"),
    taskId: Schema.optional(ChannelTaskId),
  }),
  Schema.Struct({
    type: Schema.Literal("answer_question"),
    taskId: ChannelTaskId,
    questionId: ChannelQuestionId,
    answer: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("clarify"),
    question: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("report_only") }),
]);
export type ChannelReceptionAction = typeof ChannelReceptionAction.Type;

export const ChannelReceptionResult = Schema.Struct({
  replyText: TrimmedNonEmptyString,
  action: ChannelReceptionAction,
});
export type ChannelReceptionResult = typeof ChannelReceptionResult.Type;

/** Bounds on the conversation tail a reception pass reads. */
export const CHANNEL_RECEPTION_TAIL_LIMITS = {
  messages: 20,
  bytes: 16 * 1024,
} as const;
