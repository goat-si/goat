import * as MemorySnapshot from "../memory/MemorySnapshot.ts";
import { modelSelectionsEqual } from "@goat/shared/model";
import { projectComposerContextForProvider } from "@goat/shared/composerContextReferences";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import { makeCloudResultEvents } from "./CloudResultEvents.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@goat/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { sideChatNote } from "./SideChatNote.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as CloudSource from "./CloudTaskSourceService.ts";
import { cloudTaskResultText, isCloudExecution } from "@goat/provider-core/server/cloudTask";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@goat/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import { settledBeforeStartRun } from "./runTerminationCause.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { tryWithWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class WorkspaceLeaseBusyError extends Schema.TaggedError<WorkspaceLeaseBusyError>()(
  "WorkspaceLeaseBusyError",
  {},
) {
  override get message(): string {
    return "Workspace is busy with checkout removal or preparation.";
  }
}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isCloudTaskSourceError = Schema.is(CloudSource.CloudTaskSourceError);

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * or launch arguments whose appended system prompt cannot be read.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

export interface ProviderTurnStartServiceV2Shape {
  /**
   * Starts the run's provider turn. When `willRetry` is true, a session open
   * failure is returned so the caller can retry. A workspace lease deadline
   * gives contention its own wait budget, independent of normal failures.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
    readonly workspaceLeaseDeadline?: DateTime.Utc;
    readonly reattach?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

/** A registered cloud task whose first run has not started: that run attaches, never submits. */
const isRegisteredAttach = (thread: OrchestrationV2ProviderThread | undefined) =>
  thread?.cloudTask?.attach === "registered" &&
  thread.firstRunOrdinal === null &&
  thread.nativeThreadRef !== null &&
  (thread.cloudTask.status === "running" || thread.cloudTask.status === "submitting");

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("goat/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const memorySnapshot = yield* Effect.serviceOption(MemorySnapshot.MemorySnapshot);
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const adapterRegistry = yield* Effect.serviceOption(ProviderAdapters.ProviderAdapterRegistryV2);
    const cloudSources = yield* Effect.serviceOption(CloudSource.CloudTaskSourceService);
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    // These callbacks outlive startup while a run drains background work. Build
    // them outside start's scope so they cannot retain its full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
      };
    };

    // Run workers keep this callback after startup. Capture only service references
    // and scalar ids, outside start's scope containing the projection and history.
    const makeRefreshMemoryContext = (threadId: ThreadId, runId: RunId) => () =>
      Effect.gen(function* () {
        if (Option.isNone(memorySnapshot) || !providerSessions.currentMemoryPolicy)
          return undefined;
        const currentPolicy = providerSessions.currentMemoryPolicy(threadId);
        const policy = yield* currentPolicy;
        if (policy.grant === "none") return undefined;
        if ((yield* projectionStore.getThreadShell(threadId))?.activeRunId !== runId)
          return undefined;
        const snapshot = yield* memorySnapshot.value.forThread(threadId, policy, currentPolicy);
        return (yield* projectionStore.getThreadShell(threadId))?.activeRunId === runId
          ? snapshot
          : undefined;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Memory refresh unavailable", {
                threadId,
                runId,
              }).pipe(Effect.as(undefined)),
        ),
      );

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
      readonly workspaceLeaseDeadline?: DateTime.Utc;
      readonly reattach?: boolean;
      /** Called once this start attaches a registered cloud task instead of submitting. */
      readonly onAttach?: () => void;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      const expectedStartStatus = input.reattach === true ? "running" : "starting";
      if (run.status !== expectedStartStatus) {
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      const persistedSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerThread?.providerSessionId,
      );
      const capabilities = Option.isSome(adapterRegistry)
        ? yield* (yield* adapterRegistry.value.get(run.providerInstanceId)).getCapabilities()
        : persistedSession?.capabilities;
      const cloud = capabilities !== undefined && isCloudExecution(capabilities);
      if (input.reattach === true && (!cloud || providerThread?.cloudTask === undefined)) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: "No persisted cloud task to attach.",
        });
      }
      // A registered task was launched outside GOAT: its first run only observes it.
      const attachRegistered =
        input.reattach !== true && cloud && isRegisteredAttach(providerThread);
      const observeOnly = input.reattach === true || attachRegistered;
      if (attachRegistered) input.onAttach?.();
      let cloudSource:
        | {
            source: import("@goat/contracts").OrchestrationV2CloudTask["source"];
            localChangesExcluded: boolean;
            localChangesIncluded?: boolean;
            launchSource?: ProviderAdapter.ProviderAdapterV2CloudLaunchSource;
          }
        | undefined;
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          handoff.status === "ready" &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      projection.messages.some(
                        (message) =>
                          message.id === source.userMessageId &&
                          message.attachments.length === 0 &&
                          message.text.trim().toLowerCase() === "/compact",
                      ))),
              ))),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        (!cloud && checkpointScope === undefined)
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === runId)
                  .map((item) => item.ordinal),
              ) + 1,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            { type: "run.updated", payload: settledBeforeStartRun(run, input, started) },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events = yield* Effect.forEach(eventPayloads, (event) =>
            Effect.gen(function* () {
              return {
                ...event,
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: expectedStartStatus,
            events,
          });
        },
      );
      if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
        const isEmptyCompaction =
          message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: message.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const sourceResult = yield* Effect.result(
        Effect.gen(function* () {
          return cloud &&
            input.reattach !== true &&
            (providerThread.cloudTask === undefined || providerThread.nativeThreadRef === null)
            ? yield* Effect.gen(function* () {
                if (Option.isNone(cloudSources))
                  return yield* new ProviderTurnStartError({
                    runId,
                    cause: "Cloud source preflight is unavailable.",
                  });
                const project = Option.getOrUndefined(
                  yield* projects.getById(projection.thread.projectId),
                );
                if (!project)
                  return yield* new ProviderTurnStartError({ runId, cause: "Project not found." });
                return yield* cloudSources.value.resolve({
                  cwd:
                    capabilities?.sessions.sourceRestriction === "project-folder"
                      ? project.workspaceRoot
                      : (projection.thread.worktreePath ?? project.workspaceRoot),
                  restriction: capabilities?.sessions.sourceRestriction ?? "published-ref",
                  ...(projection.thread.branch === null
                    ? {}
                    : { branch: projection.thread.branch }),
                });
              })
            : providerThread?.cloudTask === undefined
              ? undefined
              : {
                  source: providerThread.cloudTask.source,
                  localChangesExcluded: providerThread.cloudTask.localChangesExcluded,
                  ...(providerThread.cloudTask.localChangesIncluded === undefined
                    ? {}
                    : { localChangesIncluded: providerThread.cloudTask.localChangesIncluded }),
                };
        }),
      );
      if (sourceResult._tag === "Failure") {
        yield* settleRunBeforeStart({
          signal: "cloud-source-preflight",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Cloud source could not be verified",
            failure: makeProviderFailure({
              cause: sourceResult.failure,
              message: isCloudTaskSourceError(sourceResult.failure)
                ? sourceResult.failure.message
                : "Cloud source preflight failed.",
              class: "validation_error",
            }),
          },
        });
        return;
      }
      cloudSource = sourceResult.success;
      const { worktreePath, branch } = projection.thread;
      if (!cloud && worktreePath !== null) {
        // Removal may hold this lease for minutes. Return to the outbox's
        // retry schedule instead of occupying an effect-worker slot waiting.
        const prepared = yield* tryWithWorkspaceLease(
          path.resolve(worktreePath),
          Effect.gen(function* () {
            if (branch === null) return;
            const exists = yield* fileSystem
              .exists(worktreePath)
              .pipe(Effect.orElseSucceed(() => true));
            if (!exists && (yield* isManagedWorktreePath(worktreePath))) {
              const project = yield* projects.getById(projection.thread.projectId).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.orElseSucceed(() => undefined),
              );
              if (project !== undefined) {
                yield* Effect.logWarning("provider turn start recreating missing worktree", {
                  threadId: projection.thread.id,
                  worktreePath,
                  branch,
                });
                yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
                  Effect.andThen(
                    gitWorkflow.createWorktree({
                      cwd: project.workspaceRoot,
                      refName: branch,
                      path: worktreePath,
                    }),
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.interrupt
                      : Effect.logWarning("provider turn start failed to recreate worktree", {
                          threadId: projection.thread.id,
                          worktreePath,
                          cause: Cause.pretty(cause),
                        }),
                  ),
                );
              }
            }
          }),
        );
        if (Option.isNone(prepared)) {
          const reason =
            "The workspace is busy with checkout removal or preparation. Retry the turn when it finishes.";
          const now = yield* DateTime.now;
          const deadlineExceeded =
            input.workspaceLeaseDeadline !== undefined &&
            DateTime.toEpochMillis(now) >= DateTime.toEpochMillis(input.workspaceLeaseDeadline);
          if (
            !deadlineExceeded &&
            (input.workspaceLeaseDeadline !== undefined ||
              input.willRetry === true ||
              input.reattach === true)
          ) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: new WorkspaceLeaseBusyError({}),
            });
          }
          yield* settleRunBeforeStart({
            signal: "workspace-lease-busy",
            status: "failed",
            now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: "Workspace is busy",
              failure: makeProviderFailure({ message: reason, class: "validation_error" }),
            },
          });
          return;
        }
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection: run.modelSelection,
      });
      if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) return;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
        }) {
          const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
          yield* settleRunBeforeStart({
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message:
                  knownProviderFailureMessage(failed.error) ??
                  (nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message),
                class: "provider_error",
              }),
            },
          });
        },
      );
      const failedRuns = new Map(
        projection.runs
          .filter(
            (previous) =>
              previous.ordinal < run.ordinal &&
              previous.providerThreadId === providerThread.id &&
              previous.status === "failed",
          )
          .map((previous) => [previous.activeAttemptId, previous] as const),
      );
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = failedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined &&
          turn.nodeId === previous.rootNodeId
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // Older versions could fail the run without stopping its provider.
          // Recover that exact turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (input.willRetry === true) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: failedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: failedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: failedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          runId: run.id,
          ...(run.delegatedTaskId === undefined ? {} : { delegatedTaskId: run.delegatedTaskId }),
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...RunExecutionService.runPrepareInput({ run, message, projection }),
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      if (sessionResult._tag === "Failure") {
        if (input.reattach === true) return yield* sessionResult.failure;
        if (input.willRetry === true) return yield* sessionResult.failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(load);
        if (loaded._tag === "Success") return loaded.success;
        if (input.reattach === true) return yield* loaded.failure;
        if (input.willRetry === true) return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = cloud ? [] : handoffs;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (observeOnly) return providerThread;
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          return yield* loadFromProvider(
            session.forkThread({
              sourceProviderThread,
              sourceProviderTurns: sourceProjection.providerTurns,
              targetThreadId: projection.thread.id,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(sourceProviderTurn === undefined
                ? {}
                : { providerTurnId: sourceProviderTurn.id }),
            }),
          );
        }
        if (providerThread.nativeThreadRef === null) {
          // Remote cloud creation starts only after the durable intent commit.
          if (cloud) return providerThread;
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }

        if (cloud) return yield* loadFromProvider(Effect.fail(resumed.failure));
        yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery ? "uncertain_history_delivery" : "resume_failed",
          errorTag: resumed.failure._tag,
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // The native ref is dropped so the adapter binds a fresh native
            // session instead of retrying the resume that just failed, while
            // still adopting this row's identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          }),
        );
        if (replacement === undefined) return undefined;
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          runs: projection.runs,
          items: (yield* projectionStore.getTurnStartHistory(input.threadId)).filter(
            (item) =>
              item.runId === null ||
              projection.runs.some(
                (source) => source.id === item.runId && source.ordinal < run.ordinal,
              ),
          ),
          createdAt,
        });
        effectiveHandoffs = [handoff, ...effectiveHandoffs];
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) {
        return;
      }
      const now = yield* DateTime.now;
      const measuredContext = latestNativeContextUsage(projection, providerThread);
      const previousSelection =
        measuredContext?.modelSelection ??
        projection.runs.findLast(
          (source) =>
            source.ordinal < run.ordinal &&
            source.startedAt !== null &&
            source.providerThreadId === providerThread.id,
        )?.modelSelection;
      const sameSelection =
        previousSelection === undefined ||
        modelSelectionsEqual(previousSelection, run.modelSelection);
      const sameNativeThread =
        loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId;
      const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
      const previousUsage = measuredContext
        ? { ...threadUsage, ...measuredContext.usage }
        : threadUsage;
      const reuseTelemetry =
        sameSelection ||
        (previousSelection !== undefined &&
          session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
      const knownModelWindow = session.getModelContextWindow?.(
        run.modelSelection,
        resolvedRuntimePolicy.cwd,
      );
      const handoffUsage = contextUsageForHandoff({
        sameNativeThread,
        sameSelection,
        reuseTelemetry,
        previousUsage,
        knownModelWindow,
      });
      // Retain accepted ownership evidence until the provider commits its next acceptance.
      const acceptedCloudTask = providerThread.nativeThreadRef?.nativeId
        ? providerThread.cloudTask
        : undefined;
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        ...(cloudSource === undefined
          ? {}
          : {
              cloudTask:
                input.reattach === true
                  ? providerThread.cloudTask
                  : attachRegistered && providerThread.cloudTask !== undefined
                    ? {
                        ...providerThread.cloudTask,
                        acceptedAppRunId: run.id,
                        updatedAt: DateTime.formatIso(now),
                      }
                    : {
                        ...(acceptedCloudTask ?? {
                          taskId: run.id,
                          tracking: "live" as const,
                          source: cloudSource.source,
                          localChangesExcluded: cloudSource.localChangesExcluded,
                          ...(cloudSource.localChangesIncluded === undefined
                            ? {}
                            : { localChangesIncluded: cloudSource.localChangesIncluded }),
                        }),
                        status: "submitting" as const,
                        updatedAt: DateTime.formatIso(now),
                      },
            }),
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
        forkedFrom: providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: input.reattach === true ? run.startedAt : now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: input.reattach === true ? attempt.startedAt : now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: input.reattach === true ? rootNode.startedAt : now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined || runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: expectedStartStatus,
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const routableSubagents = projection.subagents.filter((subagent) =>
        RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const userText = projectComposerContextForProvider({
        text: message.text,
        records: message.context?.records ?? [],
      });
      // Delivered once: this run's provider turn marks the work as told. A
      // restart continuation is prompted by its own text or resumes natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                candidate.attachments.length === 0 &&
                candidate.text.trim().toLowerCase() === "/compact",
            )
            .map((candidate) => candidate.id),
        ),
        run,
        attempts: projection.attempts,
      });
      const restartNote = [
        yield* sideChatNote(projectionStore, projection.thread, userText),
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork),
      ]
        .filter((note) => note !== "")
        .join("\n\n");
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const settledHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.toProviderThreadId === providerThread.id &&
          handoff.delivery?.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId &&
          handoff.delivery?.status !== "pending",
      );
      const deliveredItemIds = new Set(
        settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
      );
      const coveredItemIds = new Set([
        ...deliveredItemIds,
        ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
      ]);
      const deliveredAttemptIds = new Set(
        projection.providerTurns.map((turn) => turn.runAttemptId),
      );
      const acceptedAttempts = projection.attempts.filter(
        (source) =>
          source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
      );
      const nativeInputRunIds = new Set(
        acceptedAttempts
          .filter(
            (source) =>
              source.nativeThreadId !== undefined &&
              source.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId,
          )
          .map((source) => source.runId),
      );
      const legacyInputRunIds = new Set(
        acceptedAttempts
          .filter((source) => source.nativeThreadId === undefined)
          .map((source) => source.runId),
      );
      const legacyRecoveredRunIds = new Set(
        projection.runs
          .filter(
            (source) =>
              source.providerThreadId === providerThread.id &&
              settledHandoffs.some(
                (handoff) =>
                  handoff.strategy === "full_thread_summary" &&
                  handoff.fromProviderThreadIds.includes(providerThread.id) &&
                  source.ordinal >= handoff.coveredRunOrdinals.from &&
                  source.ordinal <= handoff.coveredRunOrdinals.to,
              ),
          )
          .map((source) => source.id),
      );
      // Legacy attempts lack native identity; exclude their explicitly recovered history, whose
      // attachments were not replayed into the replacement thread.
      const nativeContextEstimate = Effect.gen(function* () {
        return sameNativeThread
          ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
              if (
                item.runId === run.id ||
                (item.runId !== null &&
                  missedRunIds.has(item.runId) &&
                  !deliveredItemIds.has(item.id)) ||
                (item.providerThreadId !== providerThread.id && !deliveredItemIds.has(item.id))
              )
                return sum;
              const historical = historicalMessage(item);
              const nativeAttachments =
                item.type === "user_message" &&
                item.providerThreadId === providerThread.id &&
                item.runId !== null &&
                (nativeInputRunIds.has(item.runId) ||
                  (legacyInputRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    !legacyRecoveredRunIds.has(item.runId)))
                  ? attachmentTokenAllowance(item.attachments)
                  : 0;
              return (
                sum +
                (historical === null ? 0 : Buffer.byteLength(historical.text)) +
                nativeAttachments
              );
            }, 0)
          : 0;
      });
      const modelContextWindow =
        knownModelWindow ??
        (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
      const budgetProviderThread = {
        ...runningProviderThread,
        contextUsage: handoffUsage,
      };
      const missedRuns = projection.runs.filter(
        (source) =>
          source.ordinal < run.ordinal &&
          source.providerThreadId === providerThread.id &&
          (source.status === "failed" || source.status === "interrupted") &&
          !deliveredAttemptIds.has(source.activeAttemptId),
      );
      const missedRunIds = new Set(missedRuns.map((source) => source.id));
      const missedItems =
        missedRunIds.size === 0
          ? []
          : (yield* projectionStore.getTurnStartHistory(input.threadId, [...missedRunIds])).filter(
              (item) =>
                item.runId !== null &&
                missedRunIds.has(item.runId) &&
                !coveredItemIds.has(item.id) &&
                historicalMessage(item) !== null,
            );
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          const retryHandoff =
            missedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact,
            providerThread: runningProviderThread,
            budget: Effect.gen(function* () {
              return handoffBudget({
                tokenCap,
                modelContextWindow,
                userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                attachments: message.attachments,
                providerThread: budgetProviderThread,
                nativeContextEstimate:
                  budgetProviderThread.contextUsage?.usedTokens === undefined
                    ? yield* nativeContextEstimate
                    : 0,
              });
            }),
            alreadyDeliveredItemIds: deliveredItemIds,
            ...(session.injectHistory === undefined
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                    }),
                }),
            persist: Effect.fn("ProviderTurnStartService.persist")(function* (handoff) {
              const updatedAt = yield* DateTime.now;
              yield* eventSink.write({
                events: [
                  {
                    id: yield* idAllocator.allocate.event({
                      threadId: projection.thread.id,
                    }),
                    type: "context-handoff.updated",
                    threadId: projection.thread.id,
                    runId: run.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: updatedAt,
                    payload: { ...handoff, updatedAt },
                  },
                ],
              });
            }),
          });
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const start = compact ? session.compactThread! : session.startTurn;
          const context = [delivery.context, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              text: context === "" ? userText : `${context}\n\nUser message:\n${userText}`,
            },
          }).pipe(
            // A pending marker would make the next turn abandon this native
            // session, though the refused prompt never reached it.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          // The provider already accepted the turn. A stale pending marker
          // can force a fresh thread later, but must not stop live ingestion.
          yield* delivery.delivered.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to record accepted context handoff delivery", {
                runId: run.id,
                deliveryStatus: "pending",
              }),
            ),
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      const deliverySession =
        effectiveHandoffs.length === 0 &&
        missedItems.length === 0 &&
        restartNote === "" &&
        !noteContinuation
          ? session
          : makeDeliverySession(session, startWithHandoffs);
      const recoveredProviderTurn =
        input.reattach === true
          ? projection.providerTurns.find(
              (turn) =>
                turn.providerThreadId === providerThread.id && turn.runAttemptId === attempt.id,
            )
          : undefined;
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session: cloud ? session : deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope: cloud ? null : checkpointScope!,
        ...(cloudSource === undefined ? {} : { cloudSource: cloudSource.source }),
        ...(cloudSource?.launchSource === undefined
          ? {}
          : { cloudLaunchSource: cloudSource.launchSource }),
        reattach: observeOnly,
        ...(observeOnly
          ? {}
          : {
              refreshMemoryContext: makeRefreshMemoryContext(input.threadId, runId),
            }),
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          recoveredProviderTurn?.ordinal ??
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        message: {
          messageId: message.id,
          text: userText,
          attachments: message.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          const originalAttemptId =
            input.reattach === true
              ? (yield* projectionStore.getTurnStartContext(input.threadId, input.runId)).runs.find(
                  (run) => run.id === input.runId,
                )?.activeAttemptId
              : undefined;
          let attaching = false;
          return yield* start({
            ...input,
            onAttach: () => {
              attaching = true;
            },
          }).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                // A retried start finds the attach run already running and returns, so an
                // attach settles on its first failure.
                if (input.reattach === true ? input.willRetry === true : !attaching)
                  return yield* Effect.fail(cause);
                const current = yield* projectionStore.getTurnStartContext(
                  input.threadId,
                  input.runId,
                );
                const run = current.runs.find((candidate) => candidate.id === input.runId);
                const thread = current.providerThreads.find(
                  (candidate) => candidate.id === run?.providerThreadId,
                );
                const attempt = current.attempts.find(
                  (candidate) => candidate.id === run?.activeAttemptId,
                );
                const root = current.nodes.find((candidate) => candidate.id === run?.rootNodeId);
                const attached =
                  input.reattach !== true &&
                  thread?.cloudTask?.attach === "registered" &&
                  thread.cloudTask.acceptedAppRunId === input.runId &&
                  thread.firstRunOrdinal === run?.ordinal;
                if (
                  (input.reattach !== true && !attached) ||
                  run?.status !== "running" ||
                  (input.reattach === true && run.activeAttemptId !== originalAttemptId) ||
                  !thread?.cloudTask ||
                  !attempt ||
                  !root
                ) {
                  return yield* Effect.fail(cause);
                }
                const now = yield* DateTime.now;
                const reason = attached
                  ? "This environment's sign-in cannot follow this cloud run, so GOAT keeps only its link. Open the link for its progress."
                  : "Cloud tracking could not be reattached. Open the task link; remote work may continue.";
                const updated = {
                  ...thread,
                  status: "idle" as const,
                  updatedAt: now,
                  cloudTask: attached
                    ? {
                        ...thread.cloudTask,
                        tracking: "link-only" as const,
                        error: reason,
                        updatedAt: DateTime.formatIso(now),
                      }
                    : {
                        ...thread.cloudTask,
                        status: "unknown" as const,
                        error: reason,
                        updatedAt: DateTime.formatIso(now),
                      },
                };
                // A link-only registration ends its attach run without claiming a result.
                const settled = attached ? ("completed" as const) : ("failed" as const);
                const allocateEventId = () =>
                  idAllocator.allocate.event({ threadId: input.threadId });
                const cloudResultEvents = yield* makeCloudResultEvents({
                  run,
                  nodeId: root.id,
                  providerThreadId: thread.id,
                  providerTurnId:
                    latestProviderTurnForAttempt(current.providerTurns, attempt.id)?.id ?? null,
                  text: cloudTaskResultText({ ...updated.cloudTask, summary: reason }),
                  completedAt: now,
                  allocateEventId,
                });
                yield* eventSink.writeIfRunCurrent({
                  threadId: input.threadId,
                  runId: run.id,
                  activeAttemptId: attempt.id,
                  expectedStatus: "running",
                  events: [
                    ...(yield* Effect.forEach(
                      [
                        { type: "provider-thread.updated" as const, payload: updated },
                        {
                          type: "run.updated" as const,
                          payload: { ...run, status: settled, completedAt: now },
                        },
                        {
                          type: "run-attempt.updated" as const,
                          payload: { ...attempt, status: settled, completedAt: now },
                        },
                        {
                          type: "node.updated" as const,
                          payload: { ...root, status: settled, completedAt: now },
                        },
                      ],
                      (event) =>
                        allocateEventId().pipe(
                          Effect.map((id) => ({
                            ...event,
                            id,
                            threadId: input.threadId,
                            runId: run.id,
                            providerInstanceId: run.providerInstanceId,
                            occurredAt: now,
                          })),
                        ),
                    )),
                    ...cloudResultEvents,
                  ],
                });
                return yield* Effect.fail(cause);
              }),
            ),
          );
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartError(cause)
                ? cause
                : new ProviderTurnStartError({ runId: input.runId, cause }),
            ),
          ),
      ),
    });
  }),
);
