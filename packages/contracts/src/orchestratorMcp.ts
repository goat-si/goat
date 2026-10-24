import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ContextTransferId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
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
  ProviderApprovalDecision,
} from "./providerPolicy.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestratorMcpRunFailure } from "./orchestratorMcpFailure.ts";
import { HostPressureAdvice } from "./hostPressure.ts";
import { OrchestratorMcpCloudTask } from "./orchestratorMcpCloudTask.ts";
import { PullRequestState } from "./pullRequest.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
} from "./threadPullRequest.ts";
import { ThreadResult } from "./threadResult.ts";
import { TurnCapability } from "./composerContext.ts";
import { ThreadReplicaStatus } from "./threadReplica.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import { OrchestrationSearchThreadsInput } from "./threadSearch.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2TaskRole,
  ReviewLedgerEntry,
  ReviewLedgerEntryInput,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { GoatclawCeilingAdvice, PermissionProfile } from "./permissionProfiles.ts";

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
    "Another machine: an SSH host alias from goat_ssh_host_list, a linked host name from goat_host_link_list, or the host goat_ssh_thread_launch returned. Omit for this environment.",
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
      description: "Configured provider instance id from goat_provider_list.",
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
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description:
        "Model options from goat_provider_list. For the same provider instance and model, overrides individual inherited values; [] or {} clears them. Claude: {effort: 'max', fastMode: true}; Codex: {reasoningEffort: 'max', serviceTier: 'priority'}. Only use options advertised by the selected model.",
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

export const OrchestratorMcpTaskRole = OrchestrationV2TaskRole;
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
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "Defaults to shared: use the parent's checkout. Worktree creates a separate checkout from the parent's current local commit before starting the child. Uncommitted edits are not copied.",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Defaults to async. Use wait only when this turn needs the child's result before you can continue. A blocking question or a pending approval in the child ends the wait early with the task still running.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description:
      "Wait budget for mode=wait only. Default 10 minutes. Elapsing it returns waitTimedOut=true on that call and does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(
    OrchestratorMcpRuntimeMode.annotate({
      description:
        "Defaults to inherit; omit it unless the user asks for a supervised child. A narrower mode is not a read-only switch: on most providers, approval-required and auto-accept-edits pause the child at each action that needs approval until a person approves it in the child's thread, which this thread cannot do. To limit what the child does, say so in the task. A mode ranked above this thread's is rejected; that ranking does not promise the child's provider permissions are narrower than this thread's.",
    }),
  ),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  cloudTask: Schema.optional(OrchestratorMcpCloudTask),
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
  role: Schema.optional(OrchestratorMcpTaskRole),
  modelSelection: Schema.optional(ModelSelection),
  parentModelSelection: Schema.optional(ModelSelection),
  reviewLedger: Schema.optional(Schema.Array(ReviewLedgerEntry)),
  options: Schema.optional(
    Schema.Array(ProviderOptionSelection).annotate({
      description:
        "Stored model option selections for the child run, or its thread before a run starts. Omitted selections use provider defaults.",
    }),
  ),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  pendingRequestIds: Schema.optional(Schema.Array(RuntimeRequestId)),
  hasPendingQuestion: Schema.Boolean.annotate({
    description:
      "Blocking question ends mode=wait. Pass threadId=childThreadId to goat_pending_request_list, goat_pending_request_read (with requestId) and goat_pending_request_respond, or ask the user; the task's completion still wakes this thread.",
  }),
  pendingApproval: Schema.NullOr(
    Schema.Struct({ requestId: RuntimeRequestId, kind: ProviderRequestKind, runId: RunId }),
  ).annotate({
    description:
      "Identity of the oldest pending live approval for this task's own unfinished work, or null. Ends mode=wait without cancelling the child; completion still wakes this thread. This grants no approval authority. Read the fresh full request in childThreadId before responding: the record can outlive its provider callback. Decisions remain with the child's existing approval holder; pending request tools answer questions only.",
  }),
  waitTimedOut: Schema.Boolean.annotate({
    description:
      "True only on that mode=wait call when timeoutMs elapsed. The timeout does not cancel the child. Later goat_task_read reads return false and use status for liveness.",
  }),
  /** Set when this machine is under resource pressure; see goat_host_status placement. */
  pressure: Schema.optional(HostPressureAdvice),
  /** Set when the remote host has not confirmed it enforces the forwarded goatclaw ceiling. */
  ceiling: Schema.optional(GoatclawCeilingAdvice),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpReviewFindingsRecordInput = Schema.Struct({
  taskId: NodeId,
  entries: Schema.Array(ReviewLedgerEntryInput).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(100),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpReviewFindingsRecordInput =
  typeof OrchestratorMcpReviewFindingsRecordInput.Type;
export const OrchestratorMcpReviewFindingsRecordResult = Schema.Struct({
  taskId: NodeId,
  reviewLedger: Schema.Array(ReviewLedgerEntry),
  findings: Schema.Array(
    Schema.Struct({
      decision: ReviewLedgerEntry.members[0],
      latestOutcome: Schema.NullOr(ReviewLedgerEntry.members[1]),
    }),
  ),
});
export type OrchestratorMcpReviewFindingsRecordResult =
  typeof OrchestratorMcpReviewFindingsRecordResult.Type;
export const OrchestratorMcpReviewFindingsExportInput = Schema.Struct({
  from: IsoDateTime,
  to: IsoDateTime,
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(1_000))),
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))),
});
export type OrchestratorMcpReviewFindingsExportInput =
  typeof OrchestratorMcpReviewFindingsExportInput.Type;
export const OrchestratorMcpReviewFindingsExportResult = Schema.Struct({
  jsonl: Schema.String,
  nextCursor: Schema.optional(Schema.String),
});
export type OrchestratorMcpReviewFindingsExportResult =
  typeof OrchestratorMcpReviewFindingsExportResult.Type;

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
const pendingResponseReasonError = {
  message:
    "Send reason with 1–2000 characters including non-whitespace text; it is shown to the user as response provenance.",
};
export const OrchestratorMcpPendingRequestRespondInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  host: Schema.optional(OrchestratorMcpHost),
  requestId: RuntimeRequestId,
  answers: Schema.optional(
    ProviderUserInputAnswers.annotate({
      description:
        'Answers keyed by question id from goat_pending_request_read, not header or option id. Use a string for single select or free text, and an array of strings for multiSelect. Select an option.value when present, otherwise its label. Custom text is allowed unless allowCustomAnswer is false. Example: {"color":"Blue","features":["Fast","Quiet"],"notes":"Keep the existing API"}. Omit decision when sending answers.',
    }),
  ),
  decision: Schema.optional(OrchestratorMcpApprovalDecision),
  reason: Schema.String.check(
    Schema.isMinLength(1, pendingResponseReasonError),
    Schema.isMaxLength(2000, pendingResponseReasonError),
    Schema.isPattern(/\S/, pendingResponseReasonError),
  ).annotate({
    description:
      'Required provenance shown to the user: explain why you chose these answers or this decision. Send 1–2000 characters including non-whitespace text, e.g. "The user requested the existing API."',
  }),
  relayedFromUser: Schema.optional(Schema.Boolean).annotate({
    description:
      "Set true when your answer relays the user's own decision. This records your claim, not verified human involvement; omit or set false for your own answer.",
  }),
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

/** A pull request linked to a thread; `state` is null until the host has been read. */
export const OrchestratorMcpThreadPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;

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
  /** Missing on older servers. */
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
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
  /** The calling thread, or null when the caller is not a GOAT thread. */
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

export const OrchestratorMcpThreadSearchInput = Schema.Struct({
  query: OrchestrationSearchThreadsInput.fields.query,
  limit: OrchestrationSearchThreadsInput.fields.limit,
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Project to search. Omit for the calling thread's project; a caller outside a GOAT thread, or a call with host, searches every project. Not allowed with hosts or allHosts, since project ids belong to one environment.",
    }),
  ),
  allProjects: Schema.optional(Schema.Boolean).annotate({
    description: "Search every project instead of one; projectId must be omitted.",
  }),
  host: Schema.optional(OrchestratorMcpHost),
  hosts: Schema.optional(Schema.Array(OrchestratorMcpHost).check(Schema.isMaxLength(16))).annotate({
    description:
      "Search these SSH hosts (every project on each) and merge the matches newest first. Hosts that cannot be searched are listed in unavailableHosts instead of failing the call. Combine with allHosts to add hosts it would not include.",
  }),
  allHosts: Schema.optional(Schema.Boolean).annotate({
    description:
      "Search this environment and every SSH host it is connected to (hosts it launched or called threads on since it started), plus any in hosts.",
  }),
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  updatedAfter: Schema.optional(
    IsoDateTime.annotate({ description: "Only threads updated at or after this ISO time." }),
  ),
  updatedBefore: Schema.optional(
    IsoDateTime.annotate({ description: "Only threads updated before this ISO time." }),
  ),
  includeArchived: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(
    // Fits a fan-out cursor naming 16 hosts with the longest aliases.
    TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)).annotate({
      description: "nextCursor from the previous page of the same search.",
    }),
  ),
});
export type OrchestratorMcpThreadSearchInput = typeof OrchestratorMcpThreadSearchInput.Type;

export const OrchestratorMcpThreadSearchMatch = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  status: OrchestratorMcpThreadStatus,
  updatedAt: IsoDateTime,
  archived: Schema.Boolean,
  /** Where the query matched: a finished user or assistant message, else the title. */
  source: Schema.Literals(["user", "assistant", "title"]),
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  /** The matched message's time; null for a title match. */
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadSearchMatch = typeof OrchestratorMcpThreadSearchMatch.Type;

export const OrchestratorMcpThreadSearchResult = Schema.Struct({
  matches: Schema.Array(OrchestratorMcpThreadSearchMatch),
  nextCursor: Schema.NullOr(Schema.String),
  /** Whether an environment had more matching threads than one search scans. */
  truncated: Schema.Boolean,
  /** For hosts and allHosts: hosts that could not be searched, with why. */
  unavailableHosts: Schema.optional(
    Schema.Array(
      Schema.Struct({ host: Schema.String, code: Schema.String, message: Schema.String }),
    ),
  ),
});
export type OrchestratorMcpThreadSearchResult = typeof OrchestratorMcpThreadSearchResult.Type;
// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on
// decode instead of failing the call; pagination returns the rest. Values below 1 still fail:
// 0 asks for nothing, and answering it with one item would be a different request.
const clampedPositiveInt = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(clampedPositiveInt(100)).annotate({
    description: "Maximum timeline items to return, from 1 to 100.",
  }),
  runLimit: Schema.optional(clampedPositiveInt(50)).annotate({
    description: "Maximum recent runs to return, from 1 to 50.",
  }),
  maxCharsPerItem: Schema.optional(clampedPositiveInt(50_000)).annotate({
    description: "Maximum text characters per item, from 1 to 50000.",
  }),
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
  /** Missing on older servers. */
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
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
  snoozedUntil: Schema.NullOr(IsoDateTime),
  /**
   * When the thread was last snoozed, kept after activity wakes it early, so a caller can tell a
   * snooze that landed and woke from one that never landed. Missing on older servers.
   */
  snoozedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Missing on older servers, which means unknown, not false. */
  pinned: Schema.optional(Schema.Boolean),
  /** Its latest run finished after the last visit. Missing on older servers: unknown. */
  unread: Schema.optional(Schema.Boolean),
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
  role: Schema.optional(OrchestratorMcpTaskRole),
  modelSelection: Schema.optional(ModelSelection),
  parentModelSelection: Schema.optional(ModelSelection),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  senderThreadId: Schema.optional(ThreadId),
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
  replicaStatus: Schema.optional(ThreadReplicaStatus),
  cloudTask: Schema.optional(OrchestratorMcpCloudTask),
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
  /** What the turn this message starts may use, as a person's `@computer` / `@browser` would. */
  capabilities: Schema.optional(Schema.Array(TurnCapability)),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  /** Set by the GOAT that forwards a send from a goatclaw-profiled caller; outside dispatch only. */
  permissionProfileCeiling: Schema.optional(PermissionProfile),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendDelivered = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
  /** Set when the host has not confirmed it enforces the forwarded goatclaw ceiling. */
  ceiling: Schema.optional(GoatclawCeilingAdvice),
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
  timeoutMs: Schema.optional(Schema.Finite),
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
  /** When the waited run ended; absent while it runs, and from hosts that predate it. */
  completedAt: Schema.optional(IsoDateTime),
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
  remoteUnavailable: Schema.optional(Schema.Boolean),
  replicaStatus: Schema.optional(ThreadReplicaStatus),
  cloudTask: Schema.optional(OrchestratorMcpCloudTask),
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
  /** What kind of failure lastError was, when the provider classified it. Older hosts omit it. */
  lastErrorClass: Schema.optional(Schema.NullOr(OrchestrationV2ProviderFailureClass)),
  /** Why the described run failed before its agent's first message. Older hosts omit it. */
  failure: Schema.optional(Schema.NullOr(OrchestratorMcpRunFailure)),
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
  replicaStatus: Schema.optional(ThreadReplicaStatus),
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
  checkpointReplication: Schema.optional(Schema.Literals(["on", "off"])),
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
  /** Stop like GOAT's Stop: also hold the thread's queue and stop the tasks it delegated. */
  stopCascade: Schema.optional(Schema.Boolean),
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
  /** Present when the queue was held and delegated tasks were stopped. */
  stopCascade: Schema.optional(Schema.Literal(true)),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpThreadRetryInput = Schema.Struct({
  threadId: ThreadId,
  host: Schema.optional(OrchestratorMcpHost),
  /** The failed run; defaults to the thread's latest run. */
  runId: Schema.optional(RunId),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadRetryInput = typeof OrchestratorMcpThreadRetryInput.Type;

export const OrchestratorMcpThreadRetryResult = Schema.Struct({
  host: OrchestratorMcpResultHost,
  threadId: ThreadId,
  runId: RunId,
  /** The run is preparing its workspace again; it starts its agent when that succeeds. */
  status: Schema.Literal("preparing"),
});
export type OrchestratorMcpThreadRetryResult = typeof OrchestratorMcpThreadRetryResult.Type;

export const OrchestratorMcpCapabilitiesInput = Schema.Struct({
  search: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description:
        "Words to match against model ids and labels. Lists matching models instead of the default short list.",
    }),
  ),
});
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpModelOption = Schema.Struct({
  id: Schema.String,
  values: Schema.Array(ProviderOptionSelectionValue),
  default: Schema.optional(ProviderOptionSelectionValue),
});
export type OrchestratorMcpModelOption = typeof OrchestratorMcpModelOption.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  executionLocation: Schema.optional(Schema.Literals(["local", "cloud"])),
  followUp: Schema.optional(
    Schema.Struct({
      supported: Schema.Boolean,
      reason: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
    }),
  ),
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Omitted when it only restates the id. A host on an older GOAT sends null. */
      label: Schema.optional(Schema.NullOr(Schema.String)),
      // A host on an older GOAT advertises full option descriptors. Remote delegation
      // still reads its capabilities, so both shapes decode.
      options: Schema.optional(
        Schema.Array(Schema.Union([OrchestratorMcpModelOption, ProviderOptionDescriptor])),
      ),
    }),
  ),
  /** Models left out of `models`: unlisted visible models, or matches past the cap with `search`. */
  omittedModels: Schema.optional(NonNegativeInt),
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  inheritedOptions: Schema.optional(Schema.Array(ProviderOptionSelection)),
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
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True (default) posts each run into this thread; false creates a fresh top-level thread per run.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

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
  runCount: Schema.optional(NonNegativeInt),
  lastRunAt: Schema.optional(Schema.NullOr(IsoDateTime)),
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
  webhookSignatureSecretRef: Schema.optional(Schema.String).annotate({
    description:
      "The secretRef the signing secret was saved from. A ref is used once, so an update that passed it saved its secret exactly when this shows it.",
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

export {
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
} from "./secretRequestTool.ts";

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
