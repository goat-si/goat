import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "@goat/contracts";
import { isSideChatThread } from "@goat/contracts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "./ProjectionStore.ts";
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  type RuntimeRequestId,
  ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import { threadTranscriptHeader } from "@goat/shared/threadTranscript";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectedRowEncodedBytes } from "./threadHistoryPaging.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";
import * as CuaDriver from "../cua/CuaDriver.ts";
import * as ComputerUseOrigin from "../cua/ComputerUseOrigin.ts";
import { currentMemoryAccess } from "../memory/MemoryAccess.ts";

/**
 * "steer_when_ready" is how another thread's agent talks to a thread: like steering, whatever
 * mode it asked for. It is server-internal and never crosses the wire.
 */
export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart" | "steer_when_ready";

/**
 * How long a send waits inside its call for a starting turn to take steering. MCP clients give a
 * tool call about a minute; past this the message is queued and still joins the turn once it can.
 */
export const STEER_READY_WAIT_MS = 45_000;

/**
 * The delivery a thread send asks for. Another thread's agent talks like steering whatever mode
 * it named; a thread's own follow-ups and clients outside GOAT threads keep queue and steer.
 */
export function threadSendMode(input: {
  readonly requested: "auto" | "queue" | "steer" | "restart" | undefined;
  readonly senderThreadId: ThreadId | undefined;
  readonly targetThreadId: ThreadId;
}): ThreadManagementSendMode {
  const requested = input.requested ?? "auto";
  if (requested === "restart") return requested;
  if (requested === "auto") return "steer_when_ready";
  return input.senderThreadId !== undefined && input.senderThreadId !== input.targetThreadId
    ? "steer_when_ready"
    : requested;
}

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
      return provenance.createdBy === "user"
        ? { ...command, respondedBy: { type: "user" } }
        : command;
    case "thread.create": {
      if (provenance.createdBy !== "user") return { ...command, ...provenance };
      const { launchedBy: _launcher, ...userCommand } = command;
      return { ...userCommand, memoryGrantCeiling: "none", ...provenance };
    }
    case "message.dispatch":
    case "delegated_task.request":
      return provenance.createdBy === "user"
        ? { ...command, memoryGrantCeiling: "none", ...provenance }
        : { ...command, ...provenance };
    case "thread.fork":
    case "thread.merge_back":
      return { ...command, ...provenance };
    default:
      return command;
  }
}

export function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.remote.register":
    case "delegated_task.remote.progress":
    case "delegated_task.remote.result":
    case "delegated_task.wake-policy":
    case "delegated_task.review-ledger.append":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    case "thread.notice.record":
      return [command.threadId];
    default:
      return [command.threadId];
  }
}

export type ThreadManagementTerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

export interface ThreadManagementSendInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadManagementSendMode;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
  readonly ignoreRequestIds?: ReadonlyArray<RuntimeRequestId>;
  /** Internal settling still waits for the run to finish. */
  readonly releaseOnPendingQuestion?: boolean;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
  readonly pendingRequestIds?: ReadonlyArray<RuntimeRequestId>;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: ThreadManagementTerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadTranscriptTooLargeError extends Schema.TaggedError<ThreadTranscriptTooLargeError>()(
  "ThreadTranscriptTooLargeError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread transcript exceeds the file attachment limit.";
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementReviewTaskFinishedError extends Schema.TaggedError<ThreadManagementReviewTaskFinishedError>()(
  "ThreadManagementReviewTaskFinishedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Review task on thread ${this.threadId} has finished. Use delegate_task to start a new review round with a fresh child.`;
  }
}

export class ThreadManagementTargetStoppedError extends Schema.TaggedError<ThreadManagementTargetStoppedError>()(
  "ThreadManagementTargetStoppedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `The turn on thread ${this.threadId} was stopped before it could take the message. Send it again to start a new turn.`;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    /** Absent when every project was listed. */
    projectId: Schema.optional(ProjectId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.projectId === undefined
      ? "Unable to list threads."
      : `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  {
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementTargetStoppedError,
  ThreadManagementReviewTaskFinishedError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | Orchestrator.OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImporter.LegacyV1ThreadImportError>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<
    Orchestrator.OrchestratorV2DispatchResult,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadHistoryPage: Orchestrator.OrchestratorV2["Service"]["getThreadHistoryPage"];
  readonly getTimelinePage: Orchestrator.OrchestratorV2["Service"]["getTimelinePage"];
  readonly getMessageCount: Orchestrator.OrchestratorV2["Service"]["getMessageCount"];
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2GetTurnItemResult, Orchestrator.OrchestratorV2Error>;
  readonly getLaunchedPendingQuestions: Orchestrator.OrchestratorV2Shape["getLaunchedPendingQuestions"];
  readonly getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"];
  readonly getReviewLedgerEntries: Orchestrator.OrchestratorV2["Service"]["getReviewLedgerEntries"];
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, Orchestrator.OrchestratorV2Error>;
  readonly getCheckpointContext: Orchestrator.OrchestratorV2["Service"]["getCheckpointContext"];
  readonly getThreadSnapshot: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getThreadTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadTranscript,
    Orchestrator.OrchestratorV2Error | ThreadTranscriptTooLargeError,
    ServerEnvironment.ServerEnvironmentIdentity
  >;
  readonly getThreadSnapshotWindow: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshotWindow"];
  readonly getProjectThreadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<
    ProjectionRecords<K>,
    ThreadManagementProjectionLoadError | ThreadManagementThreadNotFoundError
  >;
  readonly getProjectThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadManagementError>;
  readonly getShellSnapshot: (options?: {
    readonly location?: "active" | "archive";
  }) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>;
  readonly readShellSnapshot: (options?: {
    readonly location?: "active" | "archive";
  }) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
    Orchestrator.OrchestratorV2Error
  >;
  readonly getThreadShell: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  readonly listProjectThreads: (input: {
    /** Undefined lists every project. */
    readonly projectId: ProjectId | undefined;
    readonly includeSubagents: boolean;
    /** Also list archived threads; active only when omitted. */
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadManagementError>;
  /** Also checked at the origin before forwarding a send to a remote delegated child. */
  readonly assertReviewTaskSendAllowed: (input: {
    readonly threadId: ThreadId;
    readonly senderThreadId?: ThreadId;
    readonly host?: string;
    readonly createdBy: OrchestrationV2Actor;
  }) => Effect.Effect<void, ThreadManagementFailure>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  readonly assertProviderInstanceEnabled: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ThreadManagementProviderInstanceDisabledError>;
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  /**
   * A caller resolving a target ahead of a dispatch under this same command id
   * can use it to skip project-enablement filtering: the dispatch will only
   * replay the recorded result, never start anything new, so the filter would
   * just refuse a retry the project's settings no longer allow fresh.
   */
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  /** Whether a command was accepted or rejected; null when it never ran or cannot be read. */
  readonly receiptStatus: (commandId: CommandId) => Effect.Effect<"accepted" | "rejected" | null>;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  /**
   * Settling stops the provider session, so an agent that settles its own
   * thread uses this to wait for its turn to end. A run that ends any other
   * way leaves the thread active, as does anything `thread.settle` refuses
   * then, such as a queued message.
   */
  readonly settleAfterRun: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ThreadManagementFailure>;
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly byOwnAgent: boolean;
  }) => Effect.Effect<
    { readonly sequence: number } | { readonly settlesWhenTurnEnds: true },
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  readonly stopWorkflow: (
    input: OrchestrationV2StopWorkflowInput,
  ) => Effect.Effect<void, OrchestrationV2StopWorkflowError>;
  /**
   * Each stop names the thread the walk started from, so a task promoted to a top-level
   * thread while the walk runs is left running together with everything under it.
   */
  readonly stopDelegatedTasks: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly childThreadIds?: ReadonlyArray<ThreadId> | undefined;
    readonly reason?: string | undefined;
    /** The thread the cascade started from; defaults to `threadId`. */
    readonly stopCascadeFrom?: ThreadId | undefined;
  }) => Effect.Effect<
    void,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadEventSequence: Orchestrator.OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly recoverDelegatedTask: Orchestrator.OrchestratorV2["Service"]["recoverDelegatedTask"];
  readonly delegatedTaskResultPending: Orchestrator.OrchestratorV2["Service"]["delegatedTaskResultPending"];
  readonly streamStoredEvents: Orchestrator.OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("goat/orchestration-v2/ThreadManagementService") {}

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/** Joins question items to their runs without loading execution nodes or transcripts. */
export function pendingUserInputRequestIdsForRun(
  records: Pick<OrchestrationV2ThreadProjection, "turnItems" | "runtimeRequests">,
  runId: RunId,
): ReadonlyArray<RuntimeRequestId> {
  const requests = new Set(
    records.turnItems.flatMap((item) =>
      item.type === "user_input_request" && item.runId === runId ? [item.requestId] : [],
    ),
  );
  return records.runtimeRequests
    .filter(
      (request) =>
        request.kind === "user_input" && request.status === "pending" && requests.has(request.id),
    )
    .map((request) => request.id)
    .toSorted();
}

export function isTerminalRunStatus(
  status: OrchestrationV2Run["status"],
): status is ThreadManagementTerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "rolled_back"
  );
}

export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestRestartContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

export function latestActiveRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

/** The `stopDelegatedTasks` walk over the given dispatcher, shared with test harnesses. */
export function makeStopDelegatedTasks(deps: {
  readonly dispatch: ThreadManagementServiceShape["dispatch"];
  readonly getThreadRecords: Orchestrator.OrchestratorV2Shape["getThreadRecords"];
}): ThreadManagementServiceShape["stopDelegatedTasks"] {
  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = Effect.fn(
    "ThreadManagementService.stopDelegatedTasks",
  )(function* (input) {
    const { subagents } = yield* deps.getThreadRecords(input.threadId, ["subagents"]);
    const failures: Array<
      Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
    > = [];
    const stopCascadeFrom = input.stopCascadeFrom ?? input.threadId;
    for (const task of subagents) {
      if (
        task.origin !== "app_owned" ||
        task.childThreadId === null ||
        task.promotedAt !== undefined
      )
        continue;
      const threadId = task.childThreadId;
      if (input.childThreadIds !== undefined && !input.childThreadIds.includes(threadId)) continue;
      yield* deps
        .dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
          threadId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          stopCascadeFrom,
        })
        .pipe(
          Effect.andThen(
            stopDelegatedTasks({
              ...input,
              threadId,
              childThreadIds: undefined,
              stopCascadeFrom,
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Unable to stop a delegated task", {
              parentThreadId: input.threadId,
              threadId,
              error,
            }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
          ),
        );
    }
    if (failures[0] !== undefined) return yield* Effect.fail(failures[0]);
  });
  return stopDelegatedTasks;
}

function latestSteerableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;

const make = Effect.gen(function* () {
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const memoryPolicy = yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy);
  const readMemoryPolicy = Option.isSome(memoryPolicy)
    ? memoryPolicy.value.read
    : Effect.succeed({ policyReady: false, enableAgentMemoryAccess: false, epoch: 0 });
  // Evaluate current permission, never reconstruct an earlier run's issued grant.
  const projectMemoryAccess = <
    T extends {
      readonly thread: OrchestrationV2ThreadProjection["thread"];
      readonly runs?: OrchestrationV2ThreadProjection["runs"];
      readonly subagents?: OrchestrationV2ThreadProjection["subagents"];
      readonly messages?: OrchestrationV2ThreadProjection["messages"];
    },
  >(
    projection: T,
  ) =>
    Effect.gen(function* () {
      const policy = yield* readMemoryPolicy;
      // Only this destination can pass the per-record checks below. Share its
      // execution judgment lazily within this response, never across requests.
      const memoryAccessInputs = yield* Effect.cached(
        Effect.suspend(
          () =>
            sessions.memoryAccessInputs?.(
              projection.thread.id,
              projection.thread.providerInstanceId,
            ) ?? Effect.succeed(undefined),
        ),
      );
      const scheduledMessages = new Set(
        projection.messages
          ?.filter((message) => message.scheduledTaskId !== undefined)
          .map((message) => message.id),
      );
      const project = <
        R extends {
          readonly memoryGrantCeiling?: import("@goat/contracts").MemoryTaskGrantCeiling;
          readonly currentMemoryAccess?: import("@goat/contracts").MemoryCurrentAccess;
        },
      >(
        record: R,
        threadId: ThreadId | null,
        instanceId: ProviderInstanceId,
        target:
          | { readonly runId: RunId }
          | { readonly delegatedTaskId: import("@goat/contracts").NodeId },
        remote = false,
        knownTask = true,
      ) =>
        Effect.gen(function* () {
          const { currentMemoryAccess: _previous, ...saved } = record;
          // Local policy cannot describe a remote destination.
          if (remote) return saved;
          const base = currentMemoryAccess({
            ...policy,
            readOnly: false,
            memoryGrantCeiling: record.memoryGrantCeiling,
          });
          if (knownTask && base.access === "none") return { ...saved, currentMemoryAccess: base };
          // Only this thread's current projection is available without extra I/O.
          // Child destinations remain unknown until their own projection is read.
          const destination = projection.thread;
          if (
            threadId !== destination.id ||
            destination.deletedAt !== null ||
            destination.archivedAt !== null ||
            destination.providerInstanceId !== instanceId
          )
            return saved;
          const inputs = yield* memoryAccessInputs;
          const matches =
            inputs !== undefined &&
            inputs.memoryGrantCeiling === record.memoryGrantCeiling &&
            ("runId" in target
              ? inputs.runId === target.runId
              : inputs.delegatedTaskId === target.delegatedTaskId);
          return !matches || inputs === undefined
            ? saved
            : {
                ...saved,
                currentMemoryAccess: {
                  // Inputs explain the restriction; execution's current policy
                  // is the authority for the access level itself.
                  ...currentMemoryAccess({
                    ...policy,
                    ...inputs,
                    readOnly: inputs.readOnly === true,
                    memoryGrantCeiling: record.memoryGrantCeiling,
                  }),
                  access: base.access === "none" ? "none" : inputs.currentMemoryGrant,
                },
              };
        });
      return {
        ...projection,
        ...(projection.runs === undefined
          ? {}
          : {
              runs: yield* Effect.forEach(projection.runs, (run) => {
                return project(
                  run,
                  run.threadId,
                  run.providerInstanceId,
                  { runId: run.id },
                  false,
                  run.delegatedTaskId !== undefined || scheduledMessages.has(run.userMessageId),
                );
              }),
            }),
        ...(projection.subagents === undefined
          ? {}
          : {
              subagents: yield* Effect.forEach(projection.subagents, (task) =>
                project(
                  task,
                  task.childThreadId,
                  task.providerInstanceId,
                  { delegatedTaskId: task.id },
                  task.remote !== undefined || task.origin !== "app_owned",
                ),
              ),
            }),
      };
    });

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      receipts.getByCommandId(input.commandId).pipe(
        Effect.orElseSucceed(() => Option.none()),
        Effect.flatMap((receipt) =>
          Option.isSome(receipt)
            ? Effect.void
            : serverSettings.getSettings.pipe(
                Effect.orDie,
                Effect.flatMap((current) =>
                  resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId)
                    ? Effect.void
                    : new ThreadManagementProviderInstanceDisabledError({
                        projectId: input.projectId,
                        instanceId: input.instanceId,
                      }),
                ),
              ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getSettings.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(Option.isSome),
    );

  const receiptStatus: ThreadManagementServiceShape["receiptStatus"] = (commandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.map((receipt) => (Option.isSome(receipt) ? receipt.value.status : null)),
      Effect.orElseSucceed(() => null),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
      Effect.flatMap(projectMemoryAccess),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
      Effect.flatMap((snapshot) =>
        projectMemoryAccess(snapshot.projection).pipe(
          Effect.map((projection) => ({ ...snapshot, projection })),
        ),
      ),
    );
  const getThreadTranscript = Effect.fn("orchestrationV2.threadManagement.getThreadTranscript")(
    function* (threadId: ThreadId) {
      const { projection } = yield* getThreadSnapshot(threadId);
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const transcript = {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: projection.visibleTurnItems,
      };
      let sizeBytes = Buffer.byteLength(
        threadTranscriptHeader(yield* environment.getEnvironmentId, transcript),
        "utf8",
      );
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      for (const row of transcript.items) {
        sizeBytes += projectedRowEncodedBytes(row) + 1;
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new ThreadTranscriptTooLargeError({ threadId });
        }
      }
      return transcript;
    },
  );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
      Effect.flatMap((snapshot) =>
        projectMemoryAccess(snapshot.projection).pipe(
          Effect.map((projection) => ({ ...snapshot, projection })),
        ),
      ),
    );

  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              projectId: parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
            }),
          ),
        );
      default:
        return Effect.void;
    }
  };

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
    ensureCommandTranscripts(command).pipe(
      Effect.andThen(assertDispatchTargetEnabled(command)),
      Effect.andThen(orchestrator.dispatch(command)),
    );

  const getProjectThread: ThreadManagementServiceShape["getProjectThread"] = (input) =>
    getThreadProjection(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.flatMap((projection) =>
        projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
          ? Effect.succeed(projection)
          : Effect.fail(
              new ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              }),
            ),
      ),
    );

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId)
      .pipe(
        Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)),
        Effect.flatMap(projectMemoryAccess),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
        ),
        Effect.flatMap((projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
            ? Effect.succeed(projection)
            : Effect.fail(
                new ThreadManagementThreadNotFoundError({
                  projectId: input.projectId,
                  threadId: input.threadId,
                }),
              ),
        ),
      );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator
      .getShellSnapshot({
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.includeArchived === true ? {} : { location: "active" as const }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectThreadsListError({
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
              cause,
            }),
        ),
        Effect.map((snapshot) =>
          [...snapshot.threads, ...(input.includeArchived === true ? snapshot.archivedThreads : [])]
            .filter(
              (thread) =>
                // Side chats belong to the user's view of their parent, like subagents.
                input.includeSubagents ||
                (thread.lineage.relationshipToParent !== "subagent" && !isSideChatThread(thread)),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
                right.id.localeCompare(left.id),
            ),
        ),
      );

  /** Reads back the run a dispatched message started, joined, or queued behind. */
  const readDelivery = (
    input: ThreadManagementSendInput,
    dispatch: Orchestrator.OrchestratorV2DispatchResult,
    dispatchType: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" }
    >["dispatchMode"]["type"],
  ) =>
    Effect.gen(function* () {
      const projection = yield* getProjectThreadRecords(input, ["runs", "messages", "turnItems"], {
        messageIds: [input.messageId],
        turnItemTypes: ["user_message"],
      });
      const message = projection.messages.find((candidate) => candidate.id === input.messageId);
      const run =
        message?.runId === null || message?.runId === undefined
          ? undefined
          : projection.runs.find((candidate) => candidate.id === message.runId);
      const turnItem =
        projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
            candidate.type === "user_message" && candidate.messageId === input.messageId,
        ) ?? null;
      if (
        message === undefined ||
        run === undefined ||
        (turnItem === null && run.status !== "queued")
      ) {
        return yield* new ThreadManagementDurableRunProjectionError({
          threadId: input.threadId,
          messageId: input.messageId,
        });
      }
      const delivery: ThreadManagementSendResult["delivery"] =
        turnItem === null || turnItem.inputIntent === "queued_turn"
          ? "queued"
          : turnItem.inputIntent === "turn_start"
            ? "started"
            : dispatchType === "restart_active"
              ? "restarted"
              : "steered";
      return { dispatch, projection, message, run, turnItem, delivery };
    });

  /** Dispatches one message and reads back the run it started, joined, or queued behind. */
  const computerUseLeases = yield* Effect.serviceOption(ComputerUseLeases.ComputerUseLeases);
  const cuaDriver = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  /** See `gateUnattendedSteering`: such a message waits as the next turn instead. */
  const unattendedSteeringMode = (
    input: ThreadManagementSendInput,
    mode: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>["dispatchMode"],
  ) =>
    Effect.gen(function* () {
      if (
        (mode.type !== "steer_active" && mode.type !== "restart_active") ||
        (input.scheduledTaskId === undefined && input.senderThreadId === undefined)
      )
        return mode;
      // With computer use off no turn holds a driver, so steering stays as it always was,
      // including for senders on other machines this host cannot classify.
      if (Option.isNone(cuaDriver) || !(yield* cuaDriver.value.enabled)) return mode;
      const gated = yield* ComputerUseOrigin.gateUnattendedSteering(
        ComputerUseOrigin.projectionOriginReads({
          getThreadRecords: (id, fields, filter) =>
            orchestrator.getThreadRecords(id, fields, filter),
          channelOrigin: (id) =>
            Option.isSome(computerUseLeases)
              ? computerUseLeases.value.channelOrigin(id)
              : Effect.succeed(undefined),
        }),
        input,
        mode,
      );
      if (gated.queued)
        yield* Effect.logInfo(
          "An unattended message waits as the next turn instead of steering a person's turn.",
          { threadId: input.threadId, messageId: input.messageId },
        );
      return gated.mode;
    });
  const dispatchAndRead = (
    input: ThreadManagementSendInput,
    commandId: CommandId,
    requestedMode: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" }
    >["dispatchMode"],
  ) =>
    Effect.gen(function* () {
      const dispatchMode = yield* unattendedSteeringMode(input, requestedMode);
      const dispatched = yield* dispatch({
        type: "message.dispatch",
        memoryGrantCeiling: input.memoryGrantCeiling ?? "none",
        commandId,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        text: input.text,
        attachments: input.attachments,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        dispatchMode,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      return yield* readDelivery(input, dispatched, dispatchMode.type);
    });

  /**
   * Where a message from another thread's agent goes right now: into the target's running
   * turn, into a new turn, or after the current one. "wait" means the turn is starting and
   * will take steering once its provider turn runs.
   */
  const decideAgentDelivery = (
    input: Pick<ThreadManagementSendInput, "projectId" | "threadId" | "text" | "attachments">,
    observedRunId?: RunId,
  ) =>
    Effect.gen(function* () {
      const records = yield* getProjectThreadRecords(input, [
        "runs",
        "providerTurns",
        "providerThreads",
        "providerSessions",
      ]);
      const stopped = (runId: RunId) =>
        getProjectThreadRecords(input, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: [runId],
        }).pipe(Effect.map(({ turnItems }) => turnItems.length > 0));
      const active = latestActiveRun(records);
      // Stop reached the turn this message was waiting for: it never starts a new one.
      if (observedRunId !== undefined) {
        const observed = records.runs.find((run) => run.id === observedRunId);
        if (
          observed?.status === "interrupted" ||
          observed?.status === "cancelled" ||
          (yield* stopped(observedRunId))
        )
          return { type: "stopped" } as const;
      }
      if (active === undefined) return { type: "start" } as const;
      if (active.id !== observedRunId && (yield* stopped(active.id)))
        return { type: "stopped" } as const;
      if (active.status === "waiting" || Orchestrator.isSeparateTurnCommand(input))
        return { type: "next_turn" } as const;
      const activeMessage =
        active.userMessageId === null
          ? undefined
          : (yield* getProjectThreadRecords(input, ["messages"], {
              messageIds: [active.userMessageId],
            })).messages.find((message) => message.id === active.userMessageId);
      if (activeMessage !== undefined && Orchestrator.isSeparateTurnCommand(activeMessage))
        return { type: "next_turn" } as const;
      const providerThread = records.providerThreads.find(
        (candidate) => candidate.id === active.providerThreadId,
      );
      const capabilities = records.providerSessions.find(
        (session) => session.id === providerThread?.providerSessionId,
      )?.capabilities.turns;
      // A provider steers the way its own steer does: live, or by interrupting and restarting
      // the turn with the message. One that can do neither takes it as its next turn.
      if (
        capabilities !== undefined &&
        !capabilities.supportsActiveSteering &&
        !(capabilities.supportsInterrupt && capabilities.supportsSteeringByInterruptRestart)
      )
        return { type: "next_turn" } as const;
      if (capabilities !== undefined && latestSteerableRun(records)?.id === active.id)
        return { type: "steer", run: active } as const;
      return { type: "wait", run: active } as const;
    });
  type AgentDelivery = Effect.Success<ReturnType<typeof decideAgentDelivery>>;

  const isAgentDeliverySignal = (event: OrchestrationV2DomainEvent) =>
    event.type === "run.updated" ||
    event.type === "run-attempt.updated" ||
    event.type === "provider-turn.updated" ||
    event.type === "provider-session.attached" ||
    event.type === "provider-session.updated" ||
    event.type === "provider-thread.updated" ||
    (event.type === "turn-item.updated" && event.payload.type === "run_interrupt_request");

  /** Follows the thread after the given sequence, deciding again on every relevant change. */
  const agentDeliveryChanges = (
    input: ThreadManagementSendInput,
    afterSequence: number,
    observedRunId: RunId,
  ) =>
    orchestrator.streamStoredEventsFrom({ threadId: input.threadId, afterSequence }).pipe(
      Stream.filter((stored) => isAgentDeliverySignal(stored.event)),
      Stream.mapEffect(() => decideAgentDelivery(input, observedRunId)),
    );

  /**
   * A message that had to queue behind a starting turn joins that turn as soon as it can take
   * steering, also after the send returned. It is never promoted into a turn being stopped or
   * behind a held queue, and a parent's follow-up to its delegated child keeps its own task.
   */
  const promoteWhenSteerable = (
    input: ThreadManagementSendInput,
    queuedRunId: RunId,
    afterSequence: number,
    observedRunId: RunId,
  ) => {
    // A refused promotion keeps its receipt, so each attempt gets its own command id.
    let attempt = 0;
    return Stream.concat(
      Stream.fromEffect(decideAgentDelivery(input, observedRunId)),
      agentDeliveryChanges(input, afterSequence, observedRunId),
    ).pipe(
      Stream.mapEffect((decision) =>
        Effect.gen(function* () {
          const { runs } = yield* getProjectThreadRecords(input, ["runs"], {
            runIds: [queuedRunId],
          });
          const queued = runs.find((run) => run.id === queuedRunId);
          if (
            queued === undefined ||
            queued.status !== "queued" ||
            queued.queueHeld === true ||
            queued.delegatedTaskId !== undefined
          )
            return true;
          if (decision.type === "wait") return false;
          if (decision.type !== "steer") return true;
          // The same admission gate as an immediate steer: an unattended message promoted into
          // a person's turn would reach it without computer use admission. It keeps its own turn.
          const gated = yield* unattendedSteeringMode(input, {
            type: "steer_active",
            targetRunId: decision.run.id,
          });
          if (gated.type !== "steer_active") return true;
          attempt += 1;
          return yield* orchestrator
            .dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("server:agent-steer:" + queuedRunId + ":" + attempt),
              threadId: input.threadId,
              queuedRunId,
              targetRunId: decision.run.id,
            })
            .pipe(
              Effect.as(true),
              // The target ended or was stopped between reading and the lock; the next
              // event decides again, and a message that cannot steer runs as the next turn.
              Effect.catch((error) =>
                Effect.logInfo("Agent message stays queued after a refused promotion", {
                  threadId: input.threadId,
                  queuedRunId,
                  error,
                }).pipe(Effect.as(false)),
              ),
            );
        }),
      ),
      Stream.takeUntil((done) => done),
      Stream.runDrain,
    );
  };

  /**
   * Decides and delivers once, from the thread's state after the given sequence. A turn that is
   * still starting is waited for until the deadline; past that the message is queued durably and
   * promoted into the turn once it can steer. A steer refused because the turn ended or was
   * stopped in between is decided once more against that turn, within the same deadline.
   */
  const deliverFrom = (
    input: ThreadManagementSendInput,
    commandId: CommandId,
    afterSequence: number,
    observedRunId: RunId | undefined,
    deadline: number,
    redelivery: boolean,
  ): Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure> =>
    Effect.gen(function* () {
      const loadError = (cause: unknown) =>
        new ThreadManagementProjectionLoadError({
          projectId: input.projectId,
          threadId: input.threadId,
          cause,
        });
      const sequence = () =>
        orchestrator.getThreadEventSequence(input.threadId).pipe(Effect.mapError(loadError));
      let decision: AgentDelivery = yield* decideAgentDelivery(input, observedRunId);
      if (decision.type === "wait") {
        const waitingFor = decision.run.id;
        const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
        const ready = yield* agentDeliveryChanges(input, afterSequence, waitingFor).pipe(
          Stream.filter((next) => next.type !== "wait"),
          Stream.runHead,
          Effect.timeoutOption(Duration.millis(remaining)),
          Effect.mapError(loadError),
        );
        decision =
          Option.isSome(ready) && Option.isSome(ready.value)
            ? ready.value.value
            : yield* decideAgentDelivery(input, waitingFor);
      }
      if (decision.type === "stopped")
        return yield* new ThreadManagementTargetStoppedError({ threadId: input.threadId });
      // The turn is still starting after the wait a tool call can afford. Queue the message
      // durably behind that turn and keep following it so it still joins once it can. The
      // orchestrator refuses the queue if the turn stopped meanwhile, and the message is
      // decided again below.
      const queueBehind = (waitingFor: RunId) =>
        Effect.gen(function* () {
          const queuedSequence = yield* sequence();
          const queued = yield* dispatchAndRead(input, commandId, {
            type: "queue_after_active",
            behindRunId: waitingFor,
          });
          if (queued.run.status === "queued") {
            yield* promoteWhenSteerable(input, queued.run.id, queuedSequence, waitingFor).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.forkIn(layerScope),
            );
          }
          return queued;
        });
      const targetedRunId =
        decision.type === "steer" || decision.type === "wait" ? decision.run.id : observedRunId;
      const delivered =
        decision.type === "wait"
          ? queueBehind(decision.run.id)
          : dispatchAndRead(
              input,
              commandId,
              decision.type === "steer"
                ? { type: "steer_active", targetRunId: decision.run.id }
                : { type: "start_immediately" },
            );
      if (redelivery) return yield* delivered;
      const redeliver = () =>
        Effect.gen(function* () {
          return yield* deliverFrom(
            input,
            CommandId.make(commandId + ":redelivery"),
            yield* sequence(),
            targetedRunId,
            deadline,
            true,
          );
        });
      return yield* delivered.pipe(
        Effect.catchTags({
          OrchestratorDispatchError: redeliver,
          OrchestratorCommandPreviouslyRejectedError: redeliver,
        }),
      );
    });

  /**
   * Delivers a message from another thread's agent like steering, whatever mode its sender
   * picked: it joins the target's running turn, starts an idle thread, and waits for a turn
   * that is still starting. A provider that steers by interrupt-and-restart restarts the turn
   * with it; one that can do neither takes it as the next turn.
   */
  const sendAgentMessage = (input: ThreadManagementSendInput) =>
    Effect.gen(function* () {
      const target = yield* getProjectThreadRecords(input, ["messages"], {
        messageIds: [input.messageId],
      });
      if (target.thread.archivedAt !== null) {
        return yield* new ThreadManagementThreadArchivedError({ threadId: input.threadId });
      }
      const sequence = yield* orchestrator.getThreadEventSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
        ),
      );
      // A retry of a send that was already delivered reports that delivery.
      if (target.messages.some((message) => message.id === input.messageId)) {
        return yield* readDelivery(input, { sequence, storedEvents: [] }, "steer_active");
      }
      yield* assertReviewTaskSendAllowed(input);
      const deadline = (yield* Clock.currentTimeMillis) + STEER_READY_WAIT_MS;
      return yield* deliverFrom(input, input.commandId, sequence, undefined, deadline, false);
    });

  const assertReviewTaskSendAllowed: ThreadManagementServiceShape["assertReviewTaskSendAllowed"] = (
    input,
  ) =>
    Effect.gen(function* () {
      if (input.createdBy !== "agent") return;
      let parentThreadId = input.senderThreadId;
      if (input.host === undefined) {
        const target = yield* orchestrator.getThreadRecords(input.threadId, []);
        parentThreadId = target.thread.lineage.parentThreadId ?? undefined;
      }
      if (parentThreadId === undefined) return;
      const parent = yield* orchestrator.getThreadRecords(parentThreadId, ["subagents"]);
      const tasks = parent.subagents.filter(
        (task) =>
          task.origin === "app_owned" &&
          (input.host === undefined
            ? task.childThreadId === input.threadId
            : task.remote?.host === input.host && task.remote.threadId === input.threadId),
      );
      if (
        tasks.some(
          (task) =>
            task.status === "pending" || task.status === "running" || task.status === "waiting",
        )
      )
        return;
      // Provider progress and ledger writes can update an older task after a
      // follow-up starts. Choose the latest launch, not the latest update.
      const latest = tasks
        .map((task, index) => ({ task, index }))
        .toSorted(
          (a, b) =>
            (b.task.startedAt == null ? -1 : DateTime.toEpochMillis(b.task.startedAt)) -
              (a.task.startedAt == null ? -1 : DateTime.toEpochMillis(a.task.startedAt)) ||
            b.index - a.index,
        )[0]?.task;
      if (
        latest?.role === "review" &&
        (latest.status === "completed" ||
          latest.status === "failed" ||
          latest.status === "cancelled" ||
          latest.status === "interrupted")
      )
        return yield* new ThreadManagementReviewTaskFinishedError({ threadId: input.threadId });
    });

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = Effect.fn(
    "ThreadManagementService.sendToThread",
  )(function* (input) {
    if (input.mode === "steer_when_ready") return yield* sendAgentMessage(input);
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns", "messages"], {
      messageIds: [input.messageId],
    });
    if (target.thread.archivedAt !== null) {
      return yield* new ThreadManagementThreadArchivedError({
        threadId: input.threadId,
      });
    }

    if (target.messages.some((message) => message.id === input.messageId)) {
      const sequence = yield* orchestrator.getThreadEventSequence(input.threadId);
      return yield* readDelivery(
        input,
        { sequence, storedEvents: [] },
        input.mode === "restart" ? "restart_active" : "steer_active",
      );
    }
    yield* assertReviewTaskSendAllowed(input);
    const steerableRun = latestSteerableRun(target);
    let dispatchMode: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" }
    >["dispatchMode"];
    if (input.mode === "steer" || input.mode === "restart") {
      if (steerableRun === undefined) {
        return yield* new ThreadManagementNoSteerableRunError({
          threadId: input.threadId,
          mode: input.mode,
        });
      }
      dispatchMode = {
        type: input.mode === "steer" ? "steer_active" : "restart_active",
        targetRunId: steerableRun.id,
      };
    } else if (input.mode === "auto" && steerableRun !== undefined) {
      dispatchMode = { type: "steer_active", targetRunId: steerableRun.id };
    } else {
      dispatchMode = {
        type: input.mode === "queue" ? "queue_after_active" : "start_immediately",
      };
    }
    return yield* dispatchAndRead(input, input.commandId, dispatchMode);
  });

  const waitForRun: ThreadManagementServiceShape["waitForThread"] = (input) =>
    Effect.gen(function* () {
      const loadError = (cause: unknown) =>
        new ThreadManagementProjectionLoadError({
          projectId: input.projectId,
          threadId: input.threadId,
          cause,
        });
      const afterSequence = yield* orchestrator
        .getThreadEventSequence(input.threadId)
        .pipe(Effect.mapError(loadError));
      const target = yield* getProjectThreadRecords(input, ["runs"]);
      const selectedRun =
        input.runId === undefined
          ? latestRun(target)
          : target.runs.find((run) => run.id === input.runId);
      if (input.runId !== undefined && selectedRun === undefined)
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      if (selectedRun === undefined)
        return { threadId: input.threadId, run: null, timedOut: false };
      const ignoredRequestIds = new Set(input.ignoreRequestIds ?? []);
      const state = (runs: ReadonlyArray<OrchestrationV2Run>) =>
        Effect.gen(function* () {
          const selected = runs.find((candidate) => candidate.id === selectedRun.id);
          if (selected === undefined)
            return yield* new ThreadManagementRunNotFoundError({
              threadId: input.threadId,
              runId: selectedRun.id,
            });
          const run = latestRestartContinuation(runs, selected);
          const pending =
            isTerminalRunStatus(run.status) &&
            (yield* orchestrator.restartContinuationPending(run));
          let pendingRequestIds: ReadonlyArray<RuntimeRequestId> = [];
          if (input.releaseOnPendingQuestion !== false) {
            const items = yield* getProjectThreadRecords(input, ["turnItems"], {
              turnItemTypes: ["user_input_request"],
              turnItemRunIds: [run.id],
            });
            const requestIds = items.turnItems.flatMap((item) =>
              item.type === "user_input_request" &&
              item.runId === run.id &&
              !ignoredRequestIds.has(item.requestId)
                ? [item.requestId]
                : [],
            );
            if (requestIds.length > 0) {
              const requests = yield* getProjectThreadRecords(input, ["runtimeRequests"], {
                runtimeRequestIds: requestIds,
              });
              pendingRequestIds = pendingUserInputRequestIdsForRun(
                { ...items, ...requests },
                run.id,
              ).filter((requestId) => !ignoredRequestIds.has(requestId));
            }
          }
          return {
            run,
            pending,
            pendingRequestIds,
            ready: (isTerminalRunStatus(run.status) && !pending) || pendingRequestIds.length > 0,
          };
        });
      const result = (
        current: Effect.Success<ReturnType<typeof state>>,
        timedOut: boolean,
      ): ThreadManagementWaitResult => ({
        threadId: input.threadId,
        run: current.run,
        timedOut,
        ...(current.pendingRequestIds.length === 0
          ? {}
          : { pendingRequestIds: current.pendingRequestIds }),
      });
      const initial = yield* state(target.runs);
      if (initial.ready) return result(initial, false);
      const reload = () =>
        getProjectThreadRecords(input, ["runs"]).pipe(
          Effect.flatMap((current) => state(current.runs)),
        );
      // Restart continuations and pending questions both release this event-driven wait.
      // A declined continuation has no event, so its effect settling also wakes the wait.
      const updates = Stream.mergeAll(
        (
          ["run.updated", "thread.deleted", "runtime-request.updated", "turn-item.updated"] as const
        ).map((eventType) =>
          orchestrator.streamStoredEventsFrom({
            threadId: input.threadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(loadError),
        Stream.filter(
          (stored) =>
            stored.event.type !== "run.updated" ||
            stored.event.payload.id === selectedRun.id ||
            stored.event.payload.restartContinuationOfRunId !== undefined,
        ),
        Stream.filter(
          (stored) =>
            stored.event.type !== "turn-item.updated" ||
            stored.event.payload.type === "user_input_request",
        ),
      );
      const waited = Option.flatten(
        yield* Stream.merge(
          updates,
          initial.pending
            ? Stream.fromEffect(orchestrator.awaitRestartContinuation(initial.run))
            : Stream.empty,
        ).pipe(
          Stream.mapEffect(reload),
          Stream.filter((current) => current.ready),
          Stream.runHead,
          Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
        ),
      );
      if (Option.isSome(waited)) return result(waited.value, false);
      const current = yield* reload();
      return result(current, !current.ready);
    });

  /**
   * A message queued behind a starting turn may later join that turn as steering. Its queued run
   * then ends cancelled while the message lives on in the run it joined, so a wait follows it there.
   */
  const waitForThread: ThreadManagementServiceShape["waitForThread"] = Effect.fn(
    "ThreadManagementService.waitForThread",
  )(function* (input) {
    const startedAt = yield* Clock.currentTimeMillis;
    const result = yield* waitForRun(input);
    const run = result.run;
    if (run?.status !== "cancelled" || run.userMessageId == null) return result;
    const { messages } = yield* getProjectThreadRecords(input, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const joinedRunId = messages.find((message) => message.id === run.userMessageId)?.runId;
    if (joinedRunId == null || joinedRunId === run.id) return result;
    const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
    return yield* waitForRun({
      ...input,
      runId: joinedRunId,
      timeoutMs: Math.max(1, input.timeoutMs - elapsed),
    });
  });

  const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.settleAfterRun",
  )(function* (input) {
    const { run } = yield* waitForThread({
      ...input,
      timeoutMs: SETTLE_AFTER_RUN_WAIT_MS,
      releaseOnPendingQuestion: false,
    });
    if (run?.status !== "completed") return;
    yield* dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`server:settle-after-run:${input.runId}`),
      threadId: input.threadId,
    });
  });

  const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
    "orchestrationV2.threadManagement.settleThread",
  )(function* (input) {
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* settleAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return { settlesWhenTurnEnds: true } as const;
    }
    const result = yield* dispatch({
      type: "thread.settle",
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = Effect.fn(
    "ThreadManagementService.interruptThread",
  )(function* (input) {
    const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
    const explicitRun =
      input.runId === undefined
        ? undefined
        : target.runs.find((candidate) => candidate.id === input.runId);
    if (input.runId !== undefined && explicitRun === undefined) {
      return yield* new ThreadManagementRunNotFoundError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
      return {
        type: "already_terminal",
        run: explicitRun as OrchestrationV2Run & {
          readonly status: ThreadManagementTerminalRunStatus;
        },
      } as const;
    }
    const interruptibleRun = latestActiveRun(target);
    if (interruptibleRun === undefined) {
      if (input.runId === undefined) {
        return { type: "no_active_run" } as const;
      }
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
      return yield* new ThreadManagementThreadNotInterruptibleError({
        threadId: input.threadId,
        runId: input.runId,
      });
    }
    const dispatch = yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: interruptibleRun.id,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
  });

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = Effect.fn(
    "ThreadManagementService.stopWorkflow",
  )(
    function* (input) {
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      // A limited caller (an agent over MCP) may not stop work on a thread
      // running above its own modes. Checked under the thread lock, where the
      // thread's user cannot raise the modes between this read and the stop.
      const limit = yield* DispatchModeLimit;
      const exceeded =
        limit === undefined ? undefined : exceededDispatchModeLimit(limit, records.thread);
      if (limit !== undefined && exceeded !== undefined) {
        if (limit.refused !== undefined) {
          yield* Ref.set(limit.refused, {
            threadId: input.threadId,
            runtimeMode: records.thread.runtimeMode,
            interactionMode: records.thread.interactionMode,
            mode: exceeded,
          });
        }
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (task.origin !== "provider_native" || task.driver !== "claudeAgent") {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    },
    (effect, input) => effect.pipe((effect) => threadDispatch.withLock(input.threadId, effect)),
  );

  const stopDelegatedTasks = makeStopDelegatedTasks({
    dispatch,
    getThreadRecords: orchestrator.getThreadRecords,
  });

  return ThreadManagementService.of({
    getLaunchedPendingQuestions: orchestrator.getLaunchedPendingQuestions,
    ensureLegacyTranscript,
    searchThreadStream: (input) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      ),
    dispatch,
    getThreadHistoryPage: (threadId, cursor, throughEntryId, conversationOnly) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(
          orchestrator.getThreadHistoryPage(threadId, cursor, throughEntryId, conversationOnly),
        ),
      ),
    getTimelinePage: (threadId, options) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
      ),
    getMessageCount: (threadId) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      ),
    getTurnItem: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map((item) => ({ item: item === null ? null : projectTurnItemForDetail(item) })),
      ),
    getThreadRecords: (threadId, fields, filter) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
        Effect.flatMap(projectMemoryAccess),
      ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getProjectThread,
    getShellSnapshot: orchestrator.getShellSnapshot,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    getReviewLedgerEntries: orchestrator.getReviewLedgerEntries,
    listProjectThreads,
    sendToThread,
    assertReviewTaskSendAllowed,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    receiptStatus,
    waitForThread,
    settleAfterRun,
    settleThread,
    interruptThread,
    stopDelegatedTasks,
    stopWorkflow,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
});

const layerLegacyV1ThreadImporterNoop = Layer.succeed(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

export const layer: Layer.Layer<
  ThreadManagementService,
  never,
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(
  Layer.provide(layerLegacyV1ThreadImporterNoop),
  Layer.provide(ThreadCommandExecutor.layer),
);

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(Layer.provide(ThreadCommandExecutor.layer));
