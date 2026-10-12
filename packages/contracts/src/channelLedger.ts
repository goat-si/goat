import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ChannelBindingId,
  ChannelConversationId,
  ChannelInputId,
  ChannelKind,
  ChannelMessageMeta,
  ChannelQuestionId,
  ChannelReplyAddress,
  ChannelRequester,
  ChannelTaskEventId,
  ChannelTaskId,
} from "./channelCommon.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * The channel ledger: conversations keyed by their channel, the work requested in them, and
 * the append-only events that move that work. The ledger is authoritative; the GOAT bot's task
 * chips are copies of it.
 */

export const ChannelConversation = Schema.Struct({
  conversationId: ChannelConversationId,
  ownerId: TrimmedNonEmptyString,
  kind: ChannelKind,
  connectionId: TrimmedNonEmptyString,
  /** Stable per channel thread, such as `teamId:channelId:rootTs` for Slack. */
  conversationKey: TrimmedNonEmptyString,
  summary: Schema.String,
  lastActivityAt: IsoDateTime,
  expiresAt: Schema.optional(IsoDateTime),
  version: PositiveInt,
});
export type ChannelConversation = typeof ChannelConversation.Type;

export const ChannelBinding = Schema.Struct({
  bindingId: ChannelBindingId,
  conversationId: ChannelConversationId,
  connectionId: TrimmedNonEmptyString,
  replyAddress: ChannelReplyAddress,
  lastActivityAt: IsoDateTime,
  expiresAt: Schema.optional(IsoDateTime),
});
export type ChannelBinding = typeof ChannelBinding.Type;

export const ChannelTaskStatus = Schema.Literals([
  "received",
  "dispatching",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
]);
export type ChannelTaskStatus = typeof ChannelTaskStatus.Type;

export const CHANNEL_TASK_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<ChannelTaskStatus>;

/** Terminal tasks never return to running; a retry is a new generation. */
export const isChannelTaskTerminal = (status: ChannelTaskStatus): boolean =>
  (CHANNEL_TASK_TERMINAL_STATUSES as ReadonlyArray<ChannelTaskStatus>).includes(status);

/** The server converts this to a thread launch workspace strategy. */
export const ChannelWorkspaceStrategy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ChannelWorkspaceStrategy = typeof ChannelWorkspaceStrategy.Type;

/**
 * Another machine that runs the worker, reached over SSH from this environment. `host` is an
 * SSH alias this machine knows; `cwd` is the remote project's folder. The remote GOAT owns the
 * worker thread, and the worker reports back through its origin report binding.
 */
export const ChannelRemoteTarget = Schema.Struct({
  host: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
});
export type ChannelRemoteTarget = typeof ChannelRemoteTarget.Type;

/**
 * Where and how the central dispatcher runs a task, after checking the requester's ceiling.
 * With `remote`, `environmentId` and `projectId` name the remote environment and project.
 */
export const ChannelDispatchTarget = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: ChannelWorkspaceStrategy,
  remote: Schema.optional(ChannelRemoteTarget),
});
export type ChannelDispatchTarget = typeof ChannelDispatchTarget.Type;

/** `host` is set when the worker runs on another machine: open it through that connection. */
export const ChannelWorkerRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  host: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelWorkerRef = typeof ChannelWorkerRef.Type;

/** The coding thread running a task. Reports from another generation are stale. */
export const ChannelWorkerAssignment = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  generation: PositiveInt,
  /** The SSH alias of the machine running the worker; absent for this machine. */
  host: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelWorkerAssignment = typeof ChannelWorkerAssignment.Type;

export const ChannelOpenQuestion = Schema.Struct({
  questionId: ChannelQuestionId,
  text: TrimmedNonEmptyString,
  askedAt: IsoDateTime,
  /** The original requester to tag, kept from the task even when someone else replies. */
  requesterExternalActorId: Schema.optional(TrimmedNonEmptyString),
});
export type ChannelOpenQuestion = typeof ChannelOpenQuestion.Type;

/** A worker said it finished before its run did; held until the run settles. */
export const ChannelProposedCompletion = Schema.Struct({
  eventId: ChannelTaskEventId,
  generation: PositiveInt,
  runId: RunId,
  summary: TrimmedNonEmptyString,
});
export type ChannelProposedCompletion = typeof ChannelProposedCompletion.Type;

export const ChannelTask = Schema.Struct({
  taskId: ChannelTaskId,
  conversationId: ChannelConversationId,
  originBindingId: ChannelBindingId,
  /** Fixed at intake; follow-up input never changes where results go. */
  originAddress: ChannelReplyAddress,
  originInputId: ChannelInputId,
  requester: ChannelRequester,
  title: TrimmedNonEmptyString,
  instruction: Schema.String,
  status: ChannelTaskStatus,
  version: PositiveInt,
  generation: PositiveInt,
  projectId: Schema.optional(ProjectId),
  /** The machine the requester asked for, as an SSH alias; the dispatcher checks it. */
  host: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(ChannelDispatchTarget),
  worker: Schema.optional(ChannelWorkerAssignment),
  resultSummary: Schema.optional(Schema.String),
  proposedCompletion: Schema.optional(ChannelProposedCompletion),
  openQuestions: Schema.Array(ChannelOpenQuestion),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
});
export type ChannelTask = typeof ChannelTask.Type;

export const ChannelTaskEventType = Schema.Literals([
  "task.created",
  "task.dispatch.claimed",
  "task.worker.bound",
  "task.progress",
  "task.question.opened",
  "task.question.answered",
  "task.completion.proposed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.retry.requested",
]);
export type ChannelTaskEventType = typeof ChannelTaskEventType.Type;

export const ChannelTaskEventActor = Schema.Literals(["user", "agent", "system"]);
export type ChannelTaskEventActor = typeof ChannelTaskEventActor.Type;

const ChannelTaskEventBaseFields = {
  eventId: ChannelTaskEventId,
  /** Ledger-wide order. */
  sequence: NonNegativeInt,
  taskId: ChannelTaskId,
  /** The task version this event produced; unique per task. */
  taskVersion: PositiveInt,
  causationId: Schema.optional(TrimmedNonEmptyString),
  occurredAt: IsoDateTime,
  actor: ChannelTaskEventActor,
} as const;

const taskEvent = <Type extends ChannelTaskEventType, Payload extends Schema.Struct.Fields>(
  type: Type,
  payload: Payload,
) =>
  Schema.Struct({
    ...ChannelTaskEventBaseFields,
    type: Schema.Literal(type),
    payload: Schema.Struct(payload),
  });

/** Append-only task history. Each type has its own payload; nothing executes free-form JSON. */
export const ChannelTaskEvent = Schema.Union([
  taskEvent("task.created", {
    title: TrimmedNonEmptyString,
    instruction: Schema.String,
    originInputId: ChannelInputId,
  }),
  taskEvent("task.dispatch.claimed", {
    generation: PositiveInt,
    target: ChannelDispatchTarget,
    leaseExpiresAt: IsoDateTime,
  }),
  taskEvent("task.worker.bound", { worker: ChannelWorkerAssignment }),
  taskEvent("task.progress", { generation: PositiveInt, summary: TrimmedNonEmptyString }),
  taskEvent("task.question.opened", { question: ChannelOpenQuestion }),
  taskEvent("task.question.answered", {
    questionId: ChannelQuestionId,
    answer: Schema.String,
  }),
  taskEvent("task.completion.proposed", { proposal: ChannelProposedCompletion }),
  taskEvent("task.completed", {
    generation: PositiveInt,
    runId: Schema.optional(RunId),
    summary: Schema.String,
  }),
  taskEvent("task.failed", {
    generation: PositiveInt,
    reason: TrimmedNonEmptyString,
    summary: Schema.optional(Schema.String),
  }),
  taskEvent("task.cancelled", { reason: Schema.optional(Schema.String) }),
  taskEvent("task.retry.requested", { generation: PositiveInt }),
]);
export type ChannelTaskEvent = typeof ChannelTaskEvent.Type;

/**
 * The GOAT bot's view of one task, carried on a notification item. It holds no secrets, channel
 * transcripts, or tool logs. Links open `worker` directly; display text is never parsed.
 */
export const ChannelTaskChip = Schema.Struct({
  taskId: ChannelTaskId,
  conversationId: ChannelConversationId,
  /** Newer chips replace older ones; an update with a lower version is ignored. */
  taskVersion: PositiveInt,
  title: TrimmedNonEmptyString,
  status: ChannelTaskStatus,
  originKind: ChannelKind,
  requesterLabel: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  worker: Schema.optional(ChannelWorkerRef),
  summary: Schema.optional(Schema.String),
  openQuestionCount: NonNegativeInt,
});
export type ChannelTaskChip = typeof ChannelTaskChip.Type;

/** The server's canonical GOAT bot thread for this environment's owner. */
export const ChannelBotRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
});
export type ChannelBotRef = typeof ChannelBotRef.Type;

/**
 * One entry the gateway writes to the GOAT bot timeline without a provider run. `recordKey`
 * derives stable message and item ids, so retried deliveries update instead of duplicating.
 */
export const ChannelTimelineRecord = Schema.Struct({
  recordKey: TrimmedNonEmptyString,
  entry: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("message"),
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      meta: ChannelMessageMeta,
    }),
    Schema.Struct({
      type: Schema.Literal("task_chip"),
      chip: ChannelTaskChip,
    }),
  ]),
});
export type ChannelTimelineRecord = typeof ChannelTimelineRecord.Type;
