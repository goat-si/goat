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
import { ChannelTaskBrief, ChannelTaskMemoryDelivered } from "./channelBrief.ts";
import { ModelSelection } from "./modelSelection.ts";
import { MemoryTaskGrantCeiling } from "./memory.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ChannelWorkerObservation } from "./channelWorkerObservation.ts";
import { ReviewLedgerEntry } from "./orchestrationV2.ts";

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
  "reviewing",
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
  /** Automatic choices may only reuse existing connections; retries return to this project. */
  automatic: Schema.optional(
    Schema.Struct({
      sourceProjectId: ProjectId,
      canonicalKey: TrimmedNonEmptyString,
      runtimeModeCeiling: Schema.optional(RuntimeMode),
    }),
  ),
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
  /** Why this machine and provider account were chosen, such as "Codex · 46% weekly used". */
  placementReason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  /**
   * The memory the worker may use, captured from the requester when the target is chosen so
   * relaunches and remote recovery reuse it and never widen it. Absent means none.
   */
  memoryGrantCeiling: Schema.optional(MemoryTaskGrantCeiling),
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
  /** Suggested answers, recommended first; clients may show them as buttons. */
  options: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
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

/**
 * Whether the worker reported its outcome with goat_thread_report_result before its run
 * completed. Events and tasks from before this field read as unknown and show nothing.
 */
export const ChannelTaskCompletionReport = Schema.Literals(["present", "missing"]);
export type ChannelTaskCompletionReport = typeof ChannelTaskCompletionReport.Type;

/**
 * The machine a task left when it continued on another one, because the first stopped answering.
 * `replicaCapturedAt` is when the work it continued from was copied off that machine.
 */
export const ChannelTaskMove = Schema.Struct({
  host: TrimmedNonEmptyString,
  generation: PositiveInt,
  at: IsoDateTime,
  replicaCapturedAt: IsoDateTime,
});
export type ChannelTaskMove = typeof ChannelTaskMove.Type;

/**
 * One run of a task's worker thread, recorded apart from the task it serves. A task is the
 * requested work; its runs are who did it and how each ended. A run finishing does not finish the
 * task: the task is done when its outcome was delivered.
 */
export const ChannelWorkerRunStatus = Schema.Literals([
  "running",
  "waiting",
  "stalled",
  "finished",
  "failed",
  "stopped",
]);
export type ChannelWorkerRunStatus = typeof ChannelWorkerRunStatus.Type;

export const ChannelWorkerRun = Schema.Struct({
  runId: TrimmedNonEmptyString,
  taskId: ChannelTaskId,
  generation: PositiveInt,
  threadId: TrimmedNonEmptyString,
  /** The machine it runs on when it is not this one. */
  host: Schema.optional(TrimmedNonEmptyString),
  status: ChannelWorkerRunStatus,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  endedAt: Schema.optional(IsoDateTime),
});
export type ChannelWorkerRun = typeof ChannelWorkerRun.Type;

/**
 * "work" starts a coding thread wherever the requester asks. A "turn" is GOAT Bot itself
 * looking into a message with tools: it runs on this machine in the bot's own workspace, on the
 * bot's model, and its result is the bot's answer.
 */
export const ChannelTaskKind = Schema.Literals(["work", "turn"]);
export type ChannelTaskKind = typeof ChannelTaskKind.Type;

export const ChannelTaskReview = Schema.Struct({
  generation: PositiveInt,
  workerRunId: RunId,
  role: Schema.Literal("review"),
  workerModel: ModelSelection,
  reviewerModel: ModelSelection,
  round: PositiveInt,
  threadId: ThreadId,
  startedAt: IsoDateTime,
  remoteThreadId: Schema.optional(ThreadId),
  workerSummary: Schema.String,
  verdict: Schema.optional(Schema.Literals(["pass", "blockers", "failed", "skipped"])),
  summary: Schema.optional(Schema.String),
  finishedAt: Schema.optional(IsoDateTime),
  /** The pending requester question must survive a crash after recording this failure. */
  identityTimeout: Schema.optional(Schema.Literal(true)),
  // Orchestration also imports channel chips; resolve its shared finding contract lazily.
  findings: Schema.Array(Schema.suspend(() => ReviewLedgerEntry)),
}).check(
  Schema.makeFilter((review) => review.verdict !== "pass" || review.findings.length === 0, {
    message: "A passing review cannot carry findings.",
  }),
);
export type ChannelTaskReview = typeof ChannelTaskReview.Type;

export const ChannelTask = Schema.Struct({
  taskId: ChannelTaskId,
  /** Missing on tasks stored before turns existed; those are work. */
  kind: Schema.optional(ChannelTaskKind),
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
  briefVersion: Schema.optional(PositiveInt),
  projectId: Schema.optional(ProjectId),
  /** The requested or claimed machine. Automatic provenance is retained on target.remote. */
  host: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(ChannelDispatchTarget),
  worker: Schema.optional(ChannelWorkerAssignment),
  resultSummary: Schema.optional(Schema.String),
  completionReport: Schema.optional(ChannelTaskCompletionReport),
  review: Schema.optional(ChannelTaskReview),
  /** The person's request, quoted from the origin input, to change or forget a GOAT Bot note. */
  notesChangeRequested: Schema.optional(TrimmedNonEmptyString),
  proposedCompletion: Schema.optional(ChannelProposedCompletion),
  openQuestions: Schema.Array(ChannelOpenQuestion),
  /** The worker thread's pull requests, pending native requests and usage-limit wait. */
  observed: Schema.optional(ChannelWorkerObservation),
  /** Set when the task continued here from a machine that stopped answering. */
  movedFrom: Schema.optional(ChannelTaskMove),
  /**
   * The fleet goal this work item belongs to, once goals exist for GOAT Bot's work. Set by the
   * goals controller; the ledger only carries it.
   */
  goalRef: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
});
export type ChannelTask = typeof ChannelTask.Type;

export const ChannelTaskEventType = Schema.Literals([
  "task.created",
  "task.dispatch.claimed",
  "task.brief.frozen",
  "task.worker.bound",
  "task.progress",
  "task.question.opened",
  "task.question.answered",
  "task.followup.received",
  "task.completion.proposed",
  "task.review.started",
  "task.review.bound",
  "task.review.finished",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.retry.requested",
  "task.worker.observed",
  "task.moved",
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

/** The dispatcher records this once; absent means the answer has not been resolved. */
export const ChannelAnswerProjectChoice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("remote"), host: Schema.String, projectId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("local"), projectId: ProjectId }),
  Schema.Struct({ type: Schema.Literal("host"), host: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("none") }),
]);
export type ChannelAnswerProjectChoice = typeof ChannelAnswerProjectChoice.Type;

/** Task history with optional dispatcher resolution metadata on answers. */
export const ChannelTaskEvent = Schema.Union([
  taskEvent("task.created", {
    title: TrimmedNonEmptyString,
    instruction: Schema.String,
    originInputId: ChannelInputId,
    notesChangeRequested: Schema.optional(TrimmedNonEmptyString),
  }),
  taskEvent("task.dispatch.claimed", {
    generation: PositiveInt,
    target: ChannelDispatchTarget,
    leaseExpiresAt: IsoDateTime,
  }),
  taskEvent("task.brief.frozen", { brief: ChannelTaskBrief }),
  taskEvent("task.worker.bound", { worker: ChannelWorkerAssignment }),
  taskEvent("task.progress", { generation: PositiveInt, summary: TrimmedNonEmptyString }),
  taskEvent("task.question.opened", { question: ChannelOpenQuestion }),
  taskEvent("task.question.answered", {
    questionId: ChannelQuestionId,
    answer: Schema.String,
    projectChoice: Schema.optional(ChannelAnswerProjectChoice),
  }),
  /**
   * A later message about this work, recorded with the reply to it and then sent to the task's
   * worker, which takes it into its running turn or starts a new turn on the same thread.
   */
  taskEvent("task.followup.received", {
    inputId: ChannelInputId,
    text: Schema.String,
    from: TrimmedNonEmptyString,
    /** The generation it was written to; a later generation's worker never receives it. */
    generation: PositiveInt,
    /** Automatic review corrections belong only to this completed worker run. */
    expectedWorkerRunId: Schema.optional(RunId),
  }),
  taskEvent("task.completion.proposed", { proposal: ChannelProposedCompletion }),
  taskEvent("task.review.started", { review: ChannelTaskReview }),
  taskEvent("task.review.bound", {
    generation: PositiveInt,
    workerRunId: RunId,
    threadId: ThreadId,
  }),
  taskEvent("task.review.finished", { review: ChannelTaskReview }),
  taskEvent("task.completed", {
    briefVersion: Schema.optional(PositiveInt),
    generation: PositiveInt,
    runId: Schema.optional(RunId),
    summary: Schema.String,
    report: Schema.optional(ChannelTaskCompletionReport),
  }),
  taskEvent("task.failed", {
    briefVersion: Schema.optional(PositiveInt),
    generation: PositiveInt,
    reason: TrimmedNonEmptyString,
    summary: Schema.optional(Schema.String),
  }),
  taskEvent("task.cancelled", {
    reason: Schema.optional(Schema.String),
    briefVersion: Schema.optional(PositiveInt),
  }),
  taskEvent("task.retry.requested", { generation: PositiveInt }),
  taskEvent("task.worker.observed", {
    generation: PositiveInt,
    observed: ChannelWorkerObservation,
  }),
  /**
   * The worker's machine stopped answering and the task continues on `host` from the copy of its
   * work taken at `replicaCapturedAt`. Starts the next generation, so reports from the machine
   * it left are stale even when that machine wakes up.
   */
  taskEvent("task.moved", {
    generation: PositiveInt,
    host: TrimmedNonEmptyString,
    fromHost: TrimmedNonEmptyString,
    replicaCapturedAt: IsoDateTime,
  }),
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
  /** Copied from the task's target: why it runs where it runs. */
  placementReason: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  summary: Schema.optional(Schema.String),
  openQuestionCount: NonNegativeInt,
  completionReport: Schema.optional(ChannelTaskCompletionReport),
  observed: Schema.optional(ChannelWorkerObservation),
  /** Copied from the task: the machine it continued from. */
  movedFrom: Schema.optional(ChannelTaskMove),
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

const ChannelTaskOutcomeFields = {
  sequence: NonNegativeInt,
  taskId: ChannelTaskId,
  ownerId: TrimmedNonEmptyString,
  requester: ChannelRequester,
  conversationId: ChannelConversationId,
  originBindingId: ChannelBindingId,
  originAddress: ChannelReplyAddress,
  originInputId: ChannelInputId,
  title: TrimmedNonEmptyString,
  brief: Schema.NullOr(ChannelTaskBrief),
  terminalState: Schema.Literals(CHANNEL_TASK_TERMINAL_STATUSES),
  occurredAt: IsoDateTime,
  resultSummary: Schema.NullOr(Schema.String),
  evidence: Schema.NullOr(ChannelWorkerAssignment),
  reruns: NonNegativeInt,
  generation: PositiveInt,
};

/** Ledger-only source rows; thread evidence is joined by the channel export service. */
export const ChannelTaskLedgerExportRow = Schema.Struct({
  ...ChannelTaskOutcomeFields,
  channelAnswers: NonNegativeInt,
});
export type ChannelTaskLedgerExportRow = typeof ChannelTaskLedgerExportRow.Type;

export const ChannelTaskExportRow = Schema.Struct({
  ...ChannelTaskOutcomeFields,
  /** Both counters belong to this outcome's generation; reruns remains task-cumulative. */
  humanInterventions: Schema.Struct({
    channelAnswers: NonNegativeInt,
    /** Local worker's native human answers through the terminal time; null means unknown. */
    threadAnswers: Schema.NullOr(NonNegativeInt),
  }),
  memoryDelivered: ChannelTaskMemoryDelivered,
});
export type ChannelTaskExportRow = typeof ChannelTaskExportRow.Type;
