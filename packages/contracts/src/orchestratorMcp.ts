import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ContextTransferId,
  EnvironmentId,
  RuntimeRequestId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import {
  ProviderInteractionMode,
  ProviderRequestKind,
  RuntimeMode,
  ProviderUserInputAnswers,
  UserInputRespondedBy,
  UserInputResponseReason,
  ProviderApprovalDecision,
} from "./providerPolicy.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadResult } from "./threadResult.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
  description: "Complete task or message text for the target agent.",
});
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "Optional concise display title.",
});
const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
).annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

/**
 * OpenCode 1.15 has been observed serializing nested MCP union objects as JSON
 * strings. Keep the structured object as the documented form while accepting
 * that compatibility shape at the tool boundary and decoding it immediately.
 */
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description:
    "Compatibility-only JSON encoding of the schedule object. Prefer a structured object.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger object: {type:'interval', everyMs}, {type:'fixed_time', timeOfDay, weekdays?}, or {type:'webhook'} to run on each request to a generated URL. Never stringify it unless the provider requires the compatibility form.",
});

/**
 * Shorthand `{ id: value }` record form for target model options. Unlike the
 * legacy-tolerant `ProviderOptionSelections` persistence schema, this decodes
 * strictly: a value that is not a string or boolean fails the request rather
 * than being silently dropped.
 */
const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

/**
 * Another machine's SSH host alias. Threads are keyed by (host, threadId): a
 * thread id belongs to the environment that created it.
 */
export const OrchestratorMcpHost = TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
  description:
    "Another machine's SSH host alias, from goat_ssh_host_list or the host goat_ssh_thread_launch returned. Omit for this environment.",
});

export const SshLaunchWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cwd") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    branch: TrimmedNonEmptyString,
    baseRef: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Default true: fetch origin and start from origin/baseRef, falling back to the local baseRef when origin lacks it. Pass false to start from the remote's local branch, for example a stack parent pushed only there.",
      }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("existing_worktree"),
    worktreePath: TrimmedNonEmptyString,
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
]).annotate({
  description:
    'Prefer worktree for dispatched work: it creates a new Git worktree of the folder\'s repository on the remote, in that GOAT\'s worktrees folder, on branch from baseRef (default: the folder\'s checked-out branch), so parallel threads never share a checkout. For example {type:"worktree",baseRef:"dev",branch:"feat/x"}. cwd runs in the folder itself and shares it with anything else working there. existing_worktree reuses one of the worktrees goat_ssh_browse reported. Default cwd. Clean up finished worktrees with goat_worktree_cleanup or goat_worktree_remove, passing the same host.',
});

export type SshLaunchWorkspace = typeof SshLaunchWorkspace.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    ProviderInstanceId.annotate({
      description: "Configured provider instance id from orchestrator_capabilities.",
    }),
  ),
  driverKind: Schema.optional(
    ProviderDriverKind.annotate({
      description: "Provider driver kind; prefer providerInstanceId when available.",
    }),
  ),
  model: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Model id advertised for the selected provider instance.",
    }),
  ),
  /**
   * Model option selections for the child (for example reasoning effort).
   * Accepts the canonical `[{ id, value }]` array or the shorthand
   * `{ id: value }` record; valid ids come from the option descriptors
   * advertised by orchestrator_capabilities. When omitted, options inherit
   * from the parent only when the child runs the parent's provider and model.
   */
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description: "Model option selections advertised by orchestrator_capabilities.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpDelegateTarget = Schema.Struct({
  ...OrchestratorMcpTarget.fields,
  host: Schema.optional(OrchestratorMcpHost),
});

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

export const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: OrchestratorMcpPrompt.annotate({
    description: "Self-contained task for one delegated child agent/subagent.",
  }),
  target: Schema.optional(OrchestratorMcpDelegateTarget),
  remote: Schema.optional(
    Schema.Struct({ cwd: TrimmedNonEmptyString, workspace: Schema.optional(SshLaunchWorkspace) }),
  ),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Defaults to async. Use wait only when this turn needs the child's result before you can continue.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description:
      "Wait budget for mode=wait only. Default 10 minutes. Elapsing it returns waitTimedOut=true on that call and does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  taskId: NodeId,
  host: Schema.optional(Schema.String),
  childThreadId: Schema.NullOr(ThreadId),
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: Schema.Boolean,
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  waitTimedOut: Schema.Boolean.annotate({
    description:
      "True only on that mode=wait call when timeoutMs elapsed. The timeout does not cancel the child. Later task_status reads return false and use status for liveness.",
  }),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: NodeId,
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: NodeId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  Schema.Literal("starting"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description:
      "Project to act on. Omit for the calling thread's project; required when the caller is not a GOAT thread.",
  }),
);

/** Set on results that came from another machine; absent for this environment. */
const OrchestratorMcpResultHost = Schema.optional(Schema.String);

export const OrchestratorMcpPendingRequestListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  scope: Schema.optional(Schema.Literals(["thread", "launched"])),
  hosts: Schema.optional(Schema.Array(OrchestratorMcpHost).check(Schema.isMaxLength(16))),
  launcherThreadId: Schema.optional(ThreadId),
  launcherEnvironmentId: Schema.optional(EnvironmentId),
});
export type OrchestratorMcpPendingRequestListInput =
  typeof OrchestratorMcpPendingRequestListInput.Type;
export const OrchestratorMcpLaunchedQuestion = Schema.Struct({
  host: Schema.NullOr(OrchestratorMcpHost),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  requestId: RuntimeRequestId,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  humanRequired: Schema.Boolean,
});
export type OrchestratorMcpLaunchedQuestion = typeof OrchestratorMcpLaunchedQuestion.Type;
export const OrchestratorMcpLaunchedQuestionsResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  questions: Schema.Array(OrchestratorMcpLaunchedQuestion),
  truncated: Schema.Boolean,
  unavailableHosts: Schema.Array(
    Schema.Struct({ host: OrchestratorMcpHost, code: Schema.String, message: Schema.String }),
  ),
});
export type OrchestratorMcpLaunchedQuestionsResult =
  typeof OrchestratorMcpLaunchedQuestionsResult.Type;
export const OrchestratorMcpThreadPendingRequestsResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  requestIds: Schema.Array(RuntimeRequestId),
  /** Pending approvals, listed only for callers allowed to answer them. */
  approvalRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
});
export const OrchestratorMcpPendingRequestListResult = Schema.Union([
  OrchestratorMcpThreadPendingRequestsResult,
  OrchestratorMcpLaunchedQuestionsResult,
]);
export type OrchestratorMcpPendingRequestListResult =
  typeof OrchestratorMcpPendingRequestListResult.Type;
export const OrchestratorMcpPendingRequestReadInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  requestId: RuntimeRequestId,
});
export type OrchestratorMcpPendingRequestReadInput =
  typeof OrchestratorMcpPendingRequestReadInput.Type;
export const OrchestratorMcpPendingRequestReadResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  requestId: RuntimeRequestId,
  questions: Schema.Array(OrchestrationV2UserInputQuestion),
  /** Set for an approval request; its questions are empty. */
  approval: Schema.optional(
    Schema.Struct({
      kind: ProviderRequestKind,
      prompt: Schema.optional(Schema.String),
    }),
  ),
  status: Schema.optional(OrchestrationV2RuntimeRequest.fields.status),
  decision: Schema.optional(ProviderApprovalDecision),
  respondedBy: Schema.optional(UserInputRespondedBy),
  resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type OrchestratorMcpPendingRequestReadResult =
  typeof OrchestratorMcpPendingRequestReadResult.Type;
/** Single-shot approval answers; session-wide grants stay with the user. */
export const OrchestratorMcpApprovalDecision = Schema.Literals(["accept", "decline"]);
export const OrchestratorMcpPendingRequestRespondInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  requestId: RuntimeRequestId,
  answers: Schema.optional(ProviderUserInputAnswers),
  decision: Schema.optional(OrchestratorMcpApprovalDecision),
  reason: UserInputResponseReason,
  respondedBy: Schema.optional(UserInputRespondedBy),
});
export type OrchestratorMcpPendingRequestRespondInput =
  typeof OrchestratorMcpPendingRequestRespondInput.Type;
export const OrchestratorMcpPendingRequestRespondResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  sequence: NonNegativeInt,
});
export type OrchestratorMcpPendingRequestRespondResult =
  typeof OrchestratorMcpPendingRequestRespondResult.Type;

export const OrchestratorMcpThreadListInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  allProjects: Schema.optional(Schema.Boolean).annotate({
    description:
      "List every project instead of one; projectId must be omitted. A host other than this environment lists all its projects when projectId is omitted.",
  }),
  host: Schema.optional(OrchestratorMcpHost),
  allHosts: Schema.optional(Schema.Boolean).annotate({
    description:
      "List every project on this environment and on each SSH host this environment is connected to, newest first. Returns the newest limit threads without a cursor; truncated says whether more exist. Do not combine with host, projectId, or cursor.",
  }),
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  snoozed: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

export const OrchestratorMcpThreadListItem = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  host: OrchestratorMcpResultHost,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  /** When a snoozed thread wakes; null when it is not snoozed. */
  snoozedUntil: Schema.NullOr(IsoDateTime),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  /** Null when several projects are listed. */
  projectId: Schema.NullOr(ProjectId),
  host: OrchestratorMcpResultHost,
  /** The calling thread, or null when the caller is not a T3 thread. */
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
  /** For allHosts: whether more threads matched than were returned. */
  truncated: Schema.optional(Schema.Boolean),
  /** For allHosts: hosts that could not be listed, with why. */
  unavailableHosts: Schema.optional(
    Schema.Array(
      Schema.Struct({ host: Schema.String, code: Schema.String, message: Schema.String }),
    ),
  ),
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  runLimit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
  maxCharsPerItem: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50_000))),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  /** When a snoozed thread wakes; null when it is not snoozed. */
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
  /**
   * The latest run's structured result; null before the thread's first run.
   * Optional because hosts running an older GOAT do not send it.
   */
  result: Schema.optional(Schema.NullOr(ThreadResult)),
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendDelivered = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  /** Fresh task for a follow-up to an app-owned child; the previous task stays terminal. */
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type OrchestratorMcpThreadSendDelivered = typeof OrchestratorMcpThreadSendDelivered.Type;
/**
 * A send to a host this machine cannot reach, handed to the machine that launched
 * the calling thread. That machine delivers it as its launcher thread; the outcome
 * arrives there, so there is no run here to follow.
 */
export const OrchestratorMcpThreadSendRelayed = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  delivery: Schema.Literal("relayed"),
  via: Schema.String,
});
export type OrchestratorMcpThreadSendRelayed = typeof OrchestratorMcpThreadSendRelayed.Type;
export const OrchestratorMcpThreadSendResult = Schema.Union([
  OrchestratorMcpThreadSendDelivered,
  OrchestratorMcpThreadSendRelayed,
]);
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Number),
  ignoreRequestIds: Schema.optional(Schema.Array(RuntimeRequestId).check(Schema.isMaxLength(50))),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  /** The waited run's structured result, once that run has ended. */
  result: Schema.optional(ThreadResult),
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadStatusInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
});
export type OrchestratorMcpThreadStatusInput = typeof OrchestratorMcpThreadStatusInput.Type;

/**
 * Where a thread's current run is, derived from its run status and pending
 * request: idle (no run yet), queued, starting, running, waiting on the user
 * (waiting_input) or an approval (waiting_approval), waiting on something
 * else, or one of the terminal run statuses.
 */
export const OrchestratorMcpThreadPhase = Schema.Literals([
  "idle",
  "queued",
  "starting",
  "running",
  "waiting_input",
  "waiting_approval",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
export type OrchestratorMcpThreadPhase = typeof OrchestratorMcpThreadPhase.Type;

export const OrchestratorMcpThreadStatusResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  title: Schema.String,
  phase: OrchestratorMcpThreadPhase,
  /** Whether the described run does no more work. */
  terminal: Schema.Boolean,
  /** The active run, or the latest one when none is active; null before the first run. */
  run: Schema.NullOr(
    Schema.Struct({
      runId: RunId,
      status: OrchestrationV2RunStatus,
      requestedAt: IsoDateTime,
      startedAt: Schema.NullOr(IsoDateTime),
      completedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
  /** A newer run queued behind the active one, when there is one. */
  queuedRunId: Schema.NullOr(RunId),
  pendingRequest: Schema.NullOr(
    Schema.Struct({
      requestId: Schema.NullOr(RuntimeRequestId),
      kind: Schema.NullOr(Schema.String),
      since: Schema.NullOr(IsoDateTime),
    }),
  ),
  /** When anything in the thread last changed. */
  lastActivityAt: IsoDateTime,
  /** The start of the latest user or assistant message of the described or latest run, untrusted text. */
  lastMessage: Schema.NullOr(
    Schema.Struct({
      role: Schema.String,
      excerpt: Schema.String,
      at: IsoDateTime,
    }),
  ),
  /** The thread's last error, cut to 500 characters. */
  lastError: Schema.NullOr(Schema.String),
  /**
   * The caller's own launch watch on this thread: runs that will still be
   * reported, and whether its launch asked for completion webhook reports.
   * Null when the caller does not watch the thread.
   */
  watch: Schema.NullOr(
    Schema.Struct({
      /** The next run still to report, if any; at most one id. */
      pendingRunIds: Schema.Array(RunId),
      /** How many runs are still to report. */
      pendingRunCount: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
      lastReportedRunId: Schema.NullOr(RunId),
      webhook: Schema.Boolean,
    }),
  ),
});
export type OrchestratorMcpThreadStatusResult = typeof OrchestratorMcpThreadStatusResult.Type;

/**
 * A thread the calling thread is told about without polling: one it launched
 * (goat_thread_launch, goat_ssh_thread_launch) or asked to watch. The caller is
 * woken when a followed run ends, when the thread waits on a question, and
 * once when its host stays unreachable.
 */
export const OrchestratorMcpThreadWatch = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  title: Schema.NullOr(Schema.String),
  /** Runs still to report; empty while the watch waits for the next goat_thread_send. */
  pendingRunIds: Schema.Array(RunId),
  lastReportedRunId: Schema.NullOr(RunId),
  /** Set while the host cannot be reached. */
  hostUnavailableSince: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadWatch = typeof OrchestratorMcpThreadWatch.Type;

export const OrchestratorMcpThreadWatchInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
});
export type OrchestratorMcpThreadWatchInput = typeof OrchestratorMcpThreadWatchInput.Type;

export const OrchestratorMcpThreadWatchResult = Schema.Struct({
  watch: OrchestratorMcpThreadWatch,
});
export type OrchestratorMcpThreadWatchResult = typeof OrchestratorMcpThreadWatchResult.Type;

export const OrchestratorMcpThreadUnwatchResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  removed: Schema.Boolean,
});
export type OrchestratorMcpThreadUnwatchResult = typeof OrchestratorMcpThreadUnwatchResult.Type;

export const OrchestratorMcpThreadWatchListResult = Schema.Struct({
  watches: Schema.Array(OrchestratorMcpThreadWatch),
});
export type OrchestratorMcpThreadWatchListResult = typeof OrchestratorMcpThreadWatchListResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      /** Model options a target may select (for example reasoning effort). */
      options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
    }),
  ),
  /** Runtime modes the provider offers; omitted when it offers all of them. */
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  /** The calling thread, or null when the caller is not a T3 thread. */
  parentThreadId: Schema.NullOr(ThreadId),
  /** The calling thread's selection, or null when the caller is not a T3 thread. */
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  prompt: OrchestratorMcpPrompt.annotate({
    description: "Prompt executed on every scheduled run.",
  }),
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(
    Schema.Boolean.annotate({ description: "Whether the schedule starts enabled; defaults true." }),
  ),
  /**
   * When true (the default), the scheduled task fires into the calling thread
   * on each run instead of launching a fresh thread. This is the recurring
   * "wake up in this thread" behaviour reserved for agent-created tasks.
   */
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True (default) posts each run into this thread; false creates a fresh top-level thread per run.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** Summary of a scheduled task returned by the schedule/list/update tools. */
export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  /** For webhook tasks: the public T3 Connect URL, shown only to a caller that may start the task's runs. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL to give the sender. Absent when this environment has no T3 Connect managed tunnel or this caller may not start the task's runs; webhookUrlUnavailableReason then says why.",
  }),
  webhookUrlUnavailableReason: Schema.optional(Schema.String).annotate({
    description:
      "For a webhook task without webhookUrl: why it is absent and what the user can do.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])).annotate({
    description: "Whether requests must carry a valid signature.",
  }),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Only list this project's tasks. Omit for the calling thread's project, or for every project when the caller is not a GOAT thread.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "What you need, shown as the card's title, e.g. 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description:
      "One or two sentences on what it is for and where the user gets or also enters it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Hint inside the input, e.g. 'Paste your GitHub token'.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "How long to wait for the user. Default 10 minutes." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description:
      "Reuse when retrying a call that lost its result, so the user sees one card and its answer is returned again. Use a new id to ask again after timed_out or cancelled.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "secretRef holds the value." }),
    secretRef: SecretRef.annotate({
      description:
        "Pass it to a tool that accepts a secretRef; it works once, and you never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the request ended with the run. timed_out: the user did not answer in time; the card is closed, so ask again with a new clientRequestId if still needed.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export const OrchestratorMcpFailureCode = Schema.Literals([
  "capability_denied",
  "parent_not_active",
  "provider_unavailable",
  "model_unavailable",
  "runtime_mode_escalation_denied",
  "interaction_mode_escalation_denied",
  "task_not_found",
  "task_not_cancellable",
  "thread_not_found",
  "run_not_found",
  "thread_not_sendable",
  "thread_not_interruptible",
  "invalid_request",
  "orchestration_error",
  "thread_credential_required",
  "target_required",
  "host_unavailable",
  // GOAT Bot runs on another environment in this cluster; the message names it.
  "not_home",
]);
export type OrchestratorMcpFailureCode = typeof OrchestratorMcpFailureCode.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: OrchestratorMcpFailureCode,
    message: Schema.String,
  },
) {}
