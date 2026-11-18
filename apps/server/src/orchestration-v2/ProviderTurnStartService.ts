import { rejectedCodexHistory, pendingBackgroundFailure } from "./goat/RejectedCodexHistory.ts";
import { isImportedNativeSession } from "./ProviderContextBoundaries.ts";
import { makeCloudStartFailureHandler } from "./goat/CloudStartFailure.ts";
import { makeFailedStartSettlement } from "./goat/FailedStartSettlement.ts";
import { ensureSafeNativeFork } from "./goat/BusyForkSource.ts";
import { makeInheritedBackgroundSelection } from "./goat/InheritedBackgroundSelection.ts";
import { hasPendingHandoff, missingProviderSession } from "./goat/ProviderHandoffPending.ts";
import {
  isProviderTurnStartError,
  isCloudTaskSourceError,
  isProviderAdapterOpenSessionError,
  hasUnknownProviderOutcome,
} from "./goat/ProviderTurnStartErrorChecks.ts";
import { AMBIGUOUS_RESUME_MESSAGE, manualContinuationDelivery } from "./manualContinuation.ts";
import { makeMemoryRefreshFactory } from "./goat/MemoryRefreshFactory.ts";
import { makeNativeForkRecovery } from "./goat/NativeForkRecovery.ts";
import { nativeSessionMissesKeptTurns } from "./goat/NativeSessionKeptTurns.ts";
import { ProviderTurnStartError } from "./ProviderTurnStartTypes.ts";
import type { ProviderTurnStartServiceV2Shape } from "./ProviderTurnStartTypes.ts";
import * as Context from "effect/Context";
export {
  ProviderTurnStartError,
  type ProviderTurnStartServiceV2Shape,
} from "./ProviderTurnStartTypes.ts";
import { makeProviderRunControls } from "./goat/ProviderRunControls.ts";
import * as ChannelProviderInputAuthority from "../channels/channelProviderInputAuthority.ts";
import {
  queuedChannelProfileRefusal,
  providerInputFence,
} from "../channels/channelSessionProfileFence.ts";
import { restartRequiredIn } from "./ProviderSessionRetirement.ts";
import { startsNoModelTurn } from "./goat/TurnModelGate.ts";
import { WorkspaceLeaseBusyError } from "./goat/WorkspaceLeaseBusyError.ts";
export { WorkspaceLeaseBusyError } from "./goat/WorkspaceLeaseBusyError.ts";
import {
  hasNativeGoals,
  isRegisteredAttach,
  nativeForkTurns,
  providerThreadAfterSignOut,
  readyHandoffsForRun,
} from "./providerTurnStartHelpers.ts";
import { withAgentOom } from "./agentOomFailure.ts";
import { AgentScope } from "@goat/shared/AgentScope";
import {
  makeDeliverySession,
  submitWithContextHandoff,
} from "./goat/ProviderTurnDeliverySession.ts";
import { makePrepareTurnWorkspace, workspaceRestoredItem } from "./goat/prepareTurnWorkspace.ts";
import { reserveTurnStart } from "../workspace/checkpointRestoreReservation.ts";
import { makeProviderTurnHandoffRecovery } from "./goat/ProviderTurnHandoffRecovery.ts";
import { refuseCodexAdmission } from "./goat/CodexTurnAdmission.ts";
import { projectComposerContextForProvider } from "@goat/shared/composerContextReferences";
import {
  isChannelWorkerThreadId,
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  isGoatBotSessionThreadId,
  isCompactionCommandMessage,
  parseGoalCommand,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import {
  appendRemoteWorkerNotes,
  readChannelProviderBrief,
} from "../channels/channelProviderBrief.ts";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import { openFailureExplainer } from "../provider/ProviderCliGate.ts";
import * as CodexSurvivors from "../provider/CodexSurvivors.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { sideChatNote } from "./SideChatNote.ts";
import { providerTextWithSkills } from "../skills/GoatSkillText.ts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as CloudSource from "./CloudTaskSourceService.ts";
import { isCloudExecution } from "@goat/provider-core/server/cloudTask";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBudgetError,
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@goat/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import { makeSettleRunBeforeStart } from "./ProviderTurnStartSettlement.ts";
import { abandonedTurnRepairEvents, endedRunsByAttempt } from "./goat/StoppedEarlierTurn.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";
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
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const agentScope = yield* AgentScope;
    const eventSink = yield* EventSink.EventSinkV2;
    const prepareHandoffRecovery = yield* makeProviderTurnHandoffRecovery;
    const recoverNativeFork = yield* makeNativeForkRecovery;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const globalSkillsDir = (yield* ServerConfig.ServerConfig).globalSkillsDir;
    const prepareWorkspace = yield* makePrepareTurnWorkspace;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const codexSurvivors = yield* Effect.serviceOption(CodexSurvivors.CodexSurvivors);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const adapterRegistry = yield* Effect.serviceOption(ProviderAdapters.ProviderAdapterRegistryV2);
    const cloudSources = yield* Effect.serviceOption(CloudSource.CloudTaskSourceService);
    const explainOpenFailure = yield* openFailureExplainer;
    const makeRunControls = makeProviderRunControls(projectionStore, idAllocator);
    const providerInputRefusal = yield* Effect.serviceOption(
      ChannelProviderInputAuthority.ChannelProviderInputAuthority,
    );
    const makeRefreshMemoryContext = yield* makeMemoryRefreshFactory;
    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
      readonly reattach?: boolean;
      /** Called once this start attaches a registered cloud task instead of submitting. */
      readonly onAttach?: () => void;
      readonly onStarting?: (run: OrchestrationV2Run) => void;
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
      if (run.status === "starting") input.onStarting?.(run);
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
      const handoffs = readyHandoffsForRun(projection, run);
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
      // A file restore overlapping the folder the turn works in sends this start back to retry.
      const turnFolder = projection.thread.worktreePath ?? checkpointScope?.cwd;
      if (turnFolder != null && !(yield* reserveTurnStart(fileSystem, path, turnFolder)))
        return yield* new ProviderTurnStartError({ runId, cause: new WorkspaceLeaseBusyError({}) });
      const manualResume =
        run.manualContinuationOfRunId !== undefined && attempt.reason !== "steering_restart";
      const resumeDelivery = manualResume ? manualContinuationDelivery(run, projection) : undefined;
      const replaySource = resumeDelivery?.type === "replay" ? resumeDelivery.source : undefined;
      const providerMessage =
        replaySource === undefined
          ? message
          : projection.messages.find((source) => source.id === replaySource.userMessageId);
      if (providerMessage === undefined)
        return yield* new ProviderTurnStartError({
          runId,
          cause: "The unaccepted Resume message is missing.",
        });
      const replayedInput =
        replaySource === undefined
          ? undefined
          : {
              itemId: idAllocator.derive.userTurnItem({ messageId: replaySource.userMessageId }),
              threadId: replaySource.threadId,
              runOrdinal: replaySource.ordinal,
            };
      const nativeResume = resumeDelivery?.type === "native";
      const privateBrief =
        !observeOnly &&
        !nativeResume &&
        Option.isSome(sql) &&
        (isChannelWorkerThreadId(input.threadId) || isGoatBotSessionThreadId(input.threadId))
          ? yield* readChannelProviderBrief(sql.value, input.threadId, providerMessage.id)
          : undefined;
      const turnMessage =
        privateBrief === undefined ? providerMessage : { ...providerMessage, text: privateBrief };
      const settleRunBeforeStart = makeSettleRunBeforeStart({
        eventSink,
        idAllocator,
        projection,
        run,
        rootNode,
        attempt,
        expectedStartStatus,
      });
      const memoryRefusal =
        !observeOnly && Option.isSome(providerInputRefusal)
          ? providerInputRefusal.value(run.threadId, providerMessage.id, run.memoryGrantCeiling)
          : undefined;
      const profileRefusal = queuedChannelProfileRefusal(
        sql,
        observeOnly,
        attempt,
        run,
        message.id,
      );
      const profileFailure = profileRefusal === undefined ? undefined : yield* profileRefusal;
      if (profileFailure !== undefined) {
        const failure =
          memoryRefusal === undefined
            ? profileFailure
            : ((yield* memoryRefusal.pipe(
                Effect.provideService(
                  ChannelProviderInputAuthority.ProviderInputRuntimeMode,
                  projection.thread.runtimeMode,
                ),
              )) ?? profileFailure);
        yield* settleRunBeforeStart({
          signal: "channel-session-profile",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: { type: "error", title: "GOAT Bot queued turn", failure },
        });
        return;
      }
      if (turnMessage.attachments.length === 0 && turnMessage.text.trimStart().startsWith("/")) {
        const isEmptyCompaction =
          turnMessage.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparation may select a new provider; account commands still target the last native session.
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
                  text: turnMessage.text,
                  records: providerMessage.context?.records ?? [],
                }),
                hasAttachments: false,
                // A scheduled run replays a stored prompt that an agent may have edited since.
                byPerson: message.createdBy === "user" && message.scheduledTaskId === undefined,
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
                    input: turnMessage.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThreadAfterSignOut(providerThread),
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
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
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
              failure: yield* withAgentOom(
                input.threadId,
                makeProviderFailure({
                  cause: failed.error,
                  message:
                    failed.message ??
                    knownProviderFailureMessage(failed.error) ??
                    (nestedCause instanceof Error
                      ? nestedCause.message
                      : typeof nestedCause === "string"
                        ? nestedCause
                        : failed.error.message),
                  class: "provider_error",
                }),
              ).pipe(Effect.provideService(AgentScope, agentScope)),
            },
          });
        },
      );
      if (resumeDelivery?.type === "ambiguous") {
        yield* settleStartFailure({
          signal: "resume-delivery-uncertain",
          title: "Message delivery could not be confirmed",
          error: new Error(AMBIGUOUS_RESUME_MESSAGE),
        });
        return;
      }
      if (
        yield* refuseCodexAdmission({
          survivors: codexSurvivors,
          settings: serverSettings,
          driver: providerThread.driver,
          threadId: input.threadId,
          projectId: projection.thread.projectId,
          message,
          settle: settleStartFailure,
        })
      )
        return;
      const { worktreePath, branch } = projection.thread;
      if (!cloud && worktreePath !== null) {
        const prepared = yield* prepareWorkspace({ ...projection.thread, worktreePath });
        if (prepared._tag === "Busy")
          return yield* new ProviderTurnStartError({
            runId,
            cause: new WorkspaceLeaseBusyError({}),
          });
        if (prepared._tag === "Failed") {
          if (input.willRetry === true) return yield* prepared.error;
          yield* settleStartFailure({
            signal: "worktree-recreate-failure",
            title: "Couldn't recreate thread workspace",
            error: prepared.error,
            message: prepared.error.detail,
          });
          return;
        }
        if (prepared.restored !== undefined && branch !== null) {
          const now = yield* DateTime.now;
          const item = workspaceRestoredItem({
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            now,
            branch,
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: "worktree-restored" }),
            providerThreadId: providerThread.id,
            turnItems: projection.turnItems,
            restored: prepared.restored,
          });
          const eventId = yield* idAllocator.allocate.event({ threadId: projection.thread.id });
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: expectedStartStatus,
            events: [
              {
                type: "turn-item.updated",
                id: eventId,
                payload: item,
                occurredAt: now,
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: run.providerInstanceId,
              },
            ],
          });
        }
      }
      const selectInheritedBackgroundItems = makeInheritedBackgroundSelection(providerThread, run);
      const recoveryResult = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recoveryResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recoveryResult.failure;
        yield* settleStartFailure({
          signal: "runtime-recovery-read-failure",
          title: "Couldn't read thread state",
          error: recoveryResult.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recoveryResult.success);
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        worktreePath: projection.thread.worktreePath,
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
      const endedRuns = endedRunsByAttempt(projection, run, providerThread.id);
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = turn.runAttemptId === null ? undefined : endedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // Recover an older failed run's still-running native turn before reuse.
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
          // Without a session nothing was stopped; the adapter refuses a thread Codex reports busy.
          events: yield* abandonedTurnRepairEvents({
            abandoned: abandonedTurns,
            stoppedLive: Option.isSome(liveSession),
            projection,
            run,
            rootNode,
            providerThreadId: providerThread.id,
            noticeId: idAllocator.derive.runSignalTurnItem({
              runId,
              signal: "stopped-earlier-turn",
            }),
            allocateEventId: idAllocator.allocate.event({ threadId: projection.thread.id }),
            at: completedAt,
          }),
        });
        if (!repaired.committed) return;
      }
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const baseline = yield* runExecution.forkBaseline({
        run,
        checkpointScope: cloud ? null : (checkpointScope ?? null),
      });
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const brokenNativeThread = providerThread.status === "error";
      const opensFreshSession =
        brokenNativeThread && Option.isNone(yield* providerSessions.get(providerSessionId));
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          runId: run.id,
          startsTurn:
            input.reattach !== true &&
            !(yield* startsNoModelTurn(codexSurvivors, run, turnMessage, noteContinuation)),
          ...(run.delegatedTaskId === undefined ? {} : { delegatedTaskId: run.delegatedTaskId }),
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...RunExecutionService.runPrepareInput({ run, message: providerMessage, projection }),
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null || brokenNativeThread
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
        const failure = sessionResult.failure;
        const requiresSignIn =
          "cause" in failure &&
          isProviderAdapterOpenSessionError(failure.cause) &&
          failure.cause.requiresSignIn === true;
        // Retrying cannot clear a refusal that waits for running work to finish.
        if (input.willRetry === true && !requiresSignIn && restartRequiredIn(failure) === undefined)
          return yield* failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: yield* explainOpenFailure(sessionResult.failure),
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) return;
      if (session.providerSession === undefined)
        return yield* missingProviderSession(runId, session.driver);
      if (
        nativeResume &&
        (session.resumeInterruptedTurn === undefined ||
          providerThread.nativeThreadRef === null ||
          !projection.runs.some(
            (source) =>
              source.id === run.manualContinuationOfRunId &&
              source.providerThreadId === providerThread.id,
          ))
      ) {
        yield* settleStartFailure({
          signal: "resume-unsupported",
          title: "Native resume is unavailable",
          error: new ProviderAdapter.ProviderResumeUnsupportedError({
            driver: session.driver,
            providerThreadId: providerThread.id,
          }),
        });
        return;
      }
      if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(load);
        if (loaded._tag === "Success") return loaded.success;
        if (input.reattach === true) return yield* loaded.failure;
        if (input.willRetry === true && !hasUnknownProviderOutcome(loaded.failure))
          return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = cloud ? [] : handoffs;
      let resumeFellBack = false;
      let forkFellBack = false;
      const userText = nativeResume
        ? ""
        : yield* providerTextWithSkills(Option.some(serverSettings), {
            message: turnMessage,
            driver: session.driver,
            globalSkillsDir,
            project: Effect.succeed(projection.thread.projectId),
          });
      const providerText =
        observeOnly || nativeResume
          ? userText
          : yield* appendRemoteWorkerNotes(sql, projection.thread, providerMessage.id, userText);
      const goalDriver = hasNativeGoals(session);
      const goalCommand = goalDriver && parseGoalCommand(turnMessage) !== null;
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                isCompactionCommandMessage(candidate) ||
                (goalDriver && parseGoalCommand(candidate) !== null),
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
      const { handoffContextForThread, prepareRetryHandoff, recoveryHandoff, withRecoveryHandoff } =
        yield* prepareHandoffRecovery({
          threadId: input.threadId,
          projection,
          providerThread,
          run,
          session,
          cwd: resolvedRuntimePolicy.cwd,
          userText,
          restartNote,
          attachments: providerMessage.attachments,
          goalDriver,
          carriesImages:
            !nativeResume && !cloud && !goalCommand && !isCompactionCommandMessage(turnMessage),
          ...(replaySource === undefined ? {} : { replayedRunId: replaySource.id }),
          replayedInput,
        });
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      let resumedRetryHandoff: Effect.Success<ReturnType<typeof prepareRetryHandoff>> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
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
          const forked = yield* Effect.result(
            ensureSafeNativeFork(sourceProjection, sourceRun, session, sourceProviderThread).pipe(
              Effect.andThen(
                session.forkThread({
                  sourceProviderThread,
                  sourceProviderTurns: nativeForkTurns(sourceProjection),
                  targetThreadId: projection.thread.id,
                  modelSelection: run.modelSelection,
                  runtimePolicy: resolvedRuntimePolicy,
                  ...(sourceProviderTurn === undefined
                    ? {}
                    : { providerTurnId: sourceProviderTurn.id }),
                }),
              ),
            ),
          );
          if (forked._tag === "Success") return forked.success;
          if (hasUnknownProviderOutcome(forked.failure))
            return yield* loadFromProvider(Effect.fail(forked.failure));
          if (input.willRetry === true) return yield* forked.failure;
          if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) return undefined;
          const fresh = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: {
                ...providerThread,
                nativeThreadRef: null,
                forkedFrom: null,
              },
              forceNewNativeThread: true,
            }),
          );
          if (fresh === undefined || !(yield* isCurrentAttemptInStatus(expectedStartStatus)))
            return undefined;
          const handoff = yield* recoverNativeFork({
            projection,
            source: sourceProjection,
            sourceRun,
            sourceProviderThread,
            providerThread,
            freshThread: fresh,
            attemptId: attempt.id,
            run,
            rootNode,
            transfer: nativeForkTransfer,
            failure: forked.failure,
          });
          if (handoff === undefined) return undefined;
          effectiveHandoffs = withRecoveryHandoff(handoff, effectiveHandoffs);
          forkFellBack = true;
          return fresh;
        }
        if (providerThread.nativeThreadRef === null) {
          if (cloud) return providerThread;
          // The adapter must adopt this row to keep activeProviderThreadId stable.
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
        const uncertainDelivery = hasPendingHandoff(projection, providerThread);
        const nativeSessionLacksKeptTurns =
          !session.providerSession.capabilities.checkpointing.providerCanRollbackConversation &&
          nativeSessionMissesKeptTurns(projection, providerThread, run);
        const rejectedHistory = yield* rejectedCodexHistory({
          driver: session.driver,
          projection,
          run,
          providerThread,
          store: projectionStore,
        });
        if (rejectedHistory) {
          const pending = yield* pendingBackgroundFailure(session, providerThread, run);
          if (pending) return yield* loadFromProvider(Effect.fail(pending));
        }
        const importedNativeSession = isImportedNativeSession(projection, providerThread);
        const resumed = yield* Effect.result(
          brokenNativeThread || uncertainDelivery || nativeSessionLacksKeptTurns || rejectedHistory
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: uncertainDelivery
                    ? "Uncertain native history injection"
                    : nativeSessionLacksKeptTurns
                      ? "Native session holds none of the kept conversation"
                      : "Rejected native history",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                importedNativeSession,
              }),
        );
        if (resumed._tag === "Success") {
          if (cloud || nativeResume) return resumed.success;
          const context = handoffContextForThread(resumed.success);
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          resumedHandoffContext = context;
          const fits = yield* deliverContextHandoffs({
            replayedInput,
            handoffs: [...handoffs, ...resumedRetryHandoff.handoffs],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: resumedRetryHandoff.budget,
            deferInline: isCompactionCommandMessage(turnMessage) || goalCommand,
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread, true);
          const freshRetry = yield* prepareRetryHandoff(freshContext);
          const { handoff } = yield* recoveryHandoff;
          const fitsFresh = yield* deliverContextHandoffs({
            replayedInput,
            handoffs: withRecoveryHandoff(handoff, effectiveHandoffs),
            providerThread: freshThread,
            budget: freshRetry.budget,
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          const pending = yield* pendingBackgroundFailure(session, resumed.success, run);
          if (pending) return yield* loadFromProvider(Effect.fail(pending));
        }
        resumedHandoffContext = undefined;
        resumedRetryHandoff = undefined;
        if (!(yield* isCurrentAttemptInStatus(expectedStartStatus))) return undefined;
        if (
          resumed._tag === "Failure" &&
          (cloud ||
            nativeResume ||
            resumed.failure._tag === "ProviderAdapterThreadInUseError" ||
            hasUnknownProviderOutcome(resumed.failure))
        )
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : nativeSessionLacksKeptTurns
              ? "native_session_lacks_kept_turns"
              : rejectedHistory
                ? "rejected_native_history"
                : resumed._tag === "Success"
                  ? "handoff_budget_exhausted"
                  : "resume_failed",
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            ...(opensFreshSession ? {} : { forceNewNativeThread: true }),
          }),
        );
        if (replacement === undefined) return undefined;
        if (replacement.nativeThreadRef?.nativeId === providerThread.nativeThreadRef.nativeId) {
          return yield* loadFromProvider(
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId,
                cause: new ContextHandoffBudgetError(),
              }),
            ),
          );
        }
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        effectiveHandoffs = withRecoveryHandoff(handoff, effectiveHandoffs);
        resumeFellBack = true;
        const previousRun = projection.runs.findLast(
          (candidate) =>
            candidate.providerThreadId === providerThread.id &&
            candidate.ordinal < run.ordinal &&
            candidate.startedAt !== null,
        );
        const handoffTurnItemId = idAllocator.derive.runSignalTurnItem({
          runId,
          signal: "resume-fallback-handoff",
        });
        recoveryTurnItem = {
          id: handoffTurnItemId,
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* turnItemPositions.allocate({
            threadId: projection.thread.id,
            turnItemId: handoffTurnItemId,
            runId,
            runOrdinal: run.ordinal,
            placement: "run_start",
          }),
          status: "completed",
          title: "Recovered context",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "handoff",
          contextHandoffId: handoff.id,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: handoff.toProviderThreadId,
          fromProviderInstanceIds: [providerThread.providerInstanceId],
          toProviderInstanceId: run.providerInstanceId,
          fromModelSelections: previousRun === undefined ? [] : [previousRun.modelSelection],
          toModel: run.modelSelection.model,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
        };
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
      const handoffContext =
        resumedHandoffContext ?? handoffContextForThread(loadedProviderThread, resumeFellBack);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        nativeHistoryAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
      } = handoffContext;
      const retryHandoff = nativeResume
        ? { handoffs: [], attachments: providerMessage.attachments, budget: Effect.succeed(0) }
        : (resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext)));
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
        forkedFrom: forkFellBack ? null : providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? (input.reattach === true ? null : now),
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(replaySource === undefined
          ? {}
          : { replayedInputMessageId: replaySource.userMessageId }),
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
        ...(nativeForkTransfer === undefined ||
        forkFellBack ||
        runningProviderThread.nativeThreadRef === null
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
        ...(recoveryTurnItem === undefined
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: recoveryTurnItem,
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
      const routableSubagents = projection.subagents.filter(
        RunExecutionService.canRouteNativeSubagent,
      );
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          const delivery = yield* deliverContextHandoffs({
            replayedInput,
            handoffs: [...effectiveHandoffs, ...retryHandoff.handoffs],
            deferInline: compact || goalCommand,
            providerThread: runningProviderThread,
            budget: retryHandoff.budget,
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
          if (!(yield* isCurrentAttemptInStatus("running"))) return yield* delivery.unsent;
          const context = [delivery.context, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* submitWithContextHandoff(
            compact ? session.compactThread! : session.startTurn,
            noteContinuation ? promptedInput : turnInput,
            delivery,
            goalCommand ? "" : context,
            session.driver,
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
        retryHandoff.handoffs.length === 0 &&
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
        session: cloud || nativeResume ? session : deliverySession,
        resume: nativeResume,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope: cloud ? null : (checkpointScope ?? null),
        baseline,
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
            !nativeHistoryAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        ...providerInputFence(memoryRefusal, profileRefusal, resolvedRuntimePolicy.runtimeMode),
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasWorkspaceMoved: runControls.hasWorkspaceMoved,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        loadUnsettledWork: runControls.loadUnsettledWork,
        message: {
          messageId: message.id,
          text: providerText,
          attachments: retryHandoff.attachments,
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
      getStartingRunIdentity: Effect.fn("ProviderTurnStartService.getStartingRunIdentity")(
        function* ({ threadId, runId }) {
          const projection = yield* projectionStore.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          return run?.status === "starting" &&
            run.activeAttemptId !== null &&
            run.rootNodeId !== null
            ? { attemptId: run.activeAttemptId, rootNodeId: run.rootNodeId }
            : undefined;
        },
        (effect, { runId }) =>
          effect.pipe(Effect.mapError((cause) => new ProviderTurnStartError({ runId, cause }))),
      ),
      failStartingRun: makeFailedStartSettlement({ projectionStore, eventSink, idAllocator }),
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          const originalAttemptId =
            input.reattach === true
              ? (yield* projectionStore.getTurnStartContext(input.threadId, input.runId)).runs.find(
                  (run) => run.id === input.runId,
                )?.activeAttemptId
              : undefined;
          let attaching = false;
          let startingRun: OrchestrationV2Run | undefined;
          // The scope holds the turn-start reservation until startup ends.
          const startup = start({
            ...input,
            onAttach: () => void (attaching = true),
            onStarting: (run) => void (startingRun = run),
          });
          return yield* Effect.scoped(startup).pipe(
            // A start that ends before its turn registers must not keep holding the process.
            Effect.ensuring(providerSessions.settleTurnStart(input)),
            Effect.catch(
              makeCloudStartFailureHandler({
                input,
                isAttaching: () => attaching,
                originalAttemptId,
                projectionStore,
                idAllocator,
                eventSink,
              }),
            ),
            Effect.mapError((cause) => {
              if (startingRun?.activeAttemptId == null || startingRun.rootNodeId == null)
                return cause;
              const error = new ProviderTurnStartError({
                runId: input.runId,
                cause: isProviderTurnStartError(cause) ? cause.cause : cause,
                attemptId: startingRun.activeAttemptId,
                rootNodeId: startingRun.rootNodeId,
              });
              if (isProviderTurnStartError(cause)) error.message = cause.message;
              return error;
            }),
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
export const layerWithChannelAuthority = layer.pipe(
  Layer.provide(ChannelProviderInputAuthority.layer),
);
