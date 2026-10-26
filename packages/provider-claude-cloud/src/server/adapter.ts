import {
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  type ProviderInstanceId,
  type ProjectId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Adapter from "@goat/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import { CLOUD_DELIVERY_REJECTED_CODE } from "@goat/provider-core/server/cloudTask";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@goat/provider-core/server/failure";
import * as Cli from "./cli.ts";
import type { ClaudeCloudLogin } from "./cli.ts";
import {
  confirmedFailure,
  FOLLOW_UP_ACCEPTED,
  isShortenedReply,
  OBSERVATION_WINDOW_MS,
  observeCloudSession,
  recoverCloudReply,
  type Observation,
  runAnchor,
  UNKNOWN_RUN,
  withoutFailureEvidence,
} from "./observe.ts";
import {
  ClaudeCloudError,
  isClaudeCloudError,
  SESSION_ID,
  sessionUrl,
  validateLogin,
} from "./protocol.ts";

const DRIVER = ProviderDriverKind.make("claudeCloud");
const CANCEL_REASON =
  "Claude Cloud has no supported CLI cancellation command. Open the cloud session to stop it.";
export const CLAUDE_CLOUD_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  sessions: {
    executionLocation: "cloud",
    sourceRestriction: "project-folder",
    followUp: { supported: true },
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "none",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "client-boundary" },
};

type Turn = Adapter.ProviderAdapterV2TurnInput;
type Attach = Omit<Turn, "message" | "cloudLaunchSource"> & {
  readonly cloudTask: NonNullable<OrchestrationV2ProviderThread["cloudTask"]>;
};
export const makeClaudeCloudAdapter = Effect.fn("makeClaudeCloudAdapter")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly resolveLogin: Effect.Effect<ClaudeCloudLogin, ClaudeCloudError>;
  readonly resolveControlCwd: Effect.Effect<string, ClaudeCloudError>;
  /** Environment-owned folder under which each session read makes and removes its own folder. */
  readonly resolveReadRoot: Effect.Effect<string, ClaudeCloudError>;
  readonly runStartedAt: (input: Turn | Attach) => Effect.Effect<DateTime.Utc, ClaudeCloudError>;
  /**
   * The run's own message, the messages earlier runs delivered to the same session, and whether
   * this is the thread's first run on this instance, all from the saved thread.
   */
  readonly runHistory: (input: Turn | Attach) => Effect.Effect<
    {
      readonly prompt: string | undefined;
      readonly first: boolean;
    },
    ClaudeCloudError
  >;
  readonly observe: (input: {
    readonly projectId: ProjectId;
    readonly repository: string;
    readonly sessionUrl: string;
  }) => Effect.Effect<
    { readonly prUrl: string; readonly branch: string; readonly summary: string } | null,
    ClaudeCloudError
  >;
  /**
   * Folders whose Claude Code trust prompt GOAT answers on its own, and where each answer is
   * recorded. Without it, a trust prompt rejects the launch.
   */
  readonly folderTrust?: {
    readonly allowed: (cwd: string) => Effect.Effect<boolean>;
    /**
     * Answers the folder's trust prompt after Claude refused a launch, sharing one answer per
     * folder with GOAT's own background trust. Without it, the launch answers in its own Claude.
     */
    readonly accept?: (cwd: string) => Effect.Effect<void, ClaudeCloudError>;
    readonly record: (input: {
      readonly cwd: string;
      readonly threadId: Turn["threadId"];
      readonly prompts: number;
    }) => Effect.Effect<void>;
  };
}) {
  const cli = yield* Cli.ClaudeCloudCli;
  return Adapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(CLAUDE_CLOUD_CAPABILITIES),
    planSelectionTransition: (input) =>
      Effect.succeed(
        input.current.model === "cloud-default" &&
          input.target.model === "cloud-default" &&
          input.current.instanceId === options.instanceId &&
          input.target.instanceId === options.instanceId &&
          Object.keys(input.target.options ?? {}).length === 0
          ? { type: "apply_on_next_turn" as const }
          : {
              type: "reject" as const,
              reason:
                "Start a new Claude Cloud thread to change providers. The cloud session selects its model.",
            },
      ),
    openSession: Effect.fn("ClaudeCloudAdapter.openSession")(function* (input) {
      let binding: string | undefined;
      const scope = yield* Scope.Scope;
      const bus = yield* Effect.acquireRelease(
        PubSub.unbounded<Adapter.ProviderAdapterV2Event>(),
        PubSub.shutdown,
      );
      const lock = yield* Semaphore.make(1);
      const threads = new Map<ProviderThreadId, OrchestrationV2ProviderThread>();
      const turns = new Map<ProviderTurnId, OrchestrationV2ProviderTurn>();
      const begun = new Set<string>();
      const now = yield* DateTime.now;
      let session = {
        id: input.providerSessionId,
        driver: DRIVER,
        providerInstanceId: options.instanceId,
        status: "ready" as const,
        cwd: input.runtimePolicy.cwd ?? ".",
        model: "cloud-default",
        capabilities: {
          ...CLAUDE_CLOUD_CAPABILITIES,
          sessions: {
            ...CLAUDE_CLOUD_CAPABILITIES.sessions,
            followUp: input.resumeFromSession?.capabilities.sessions.followUp ?? {
              supported: true,
            },
          },
        },
        createdAt: input.resumeFromSession?.createdAt ?? now,
        updatedAt: now,
        lastError: null,
      };
      const publish = (event: Adapter.ProviderAdapterV2Event) =>
        PubSub.publish(bus, event).pipe(Effect.asVoid);
      const saveThread = (thread: OrchestrationV2ProviderThread) =>
        Effect.gen(function* () {
          threads.set(thread.id, thread);
          yield* publish({
            type: "provider_thread.updated",
            driver: DRIVER,
            providerThread: thread,
          });
        });
      const block = Effect.fn("ClaudeCloudAdapter.block")(function* (reason: string) {
        session = {
          ...session,
          updatedAt: yield* DateTime.now,
          capabilities: {
            ...session.capabilities,
            sessions: { ...session.capabilities.sessions, followUp: { supported: false, reason } },
          },
        };
        yield* publish({
          type: "provider_session.updated",
          driver: DRIVER,
          providerSession: session,
        });
      });
      const unsupported = (detail: string) =>
        Effect.fail(new Adapter.ProviderAdapterProtocolError({ driver: DRIVER, detail }));
      const commit = Effect.fn("ClaudeCloudAdapter.commit")(function* (
        i: Turn | Attach,
        thread: OrchestrationV2ProviderThread,
      ) {
        if (!i.commitCloudTask || !thread.cloudTask)
          return yield* new ClaudeCloudError({
            detail:
              "Durable cloud-task acknowledgement is unavailable; no remote operation is safe.",
            outcome: "uncertain",
          });
        yield* i
          .commitCloudTask(thread.cloudTask, {
            nativeThreadRef: thread.nativeThreadRef,
            nativeConversationHeadRef: thread.nativeConversationHeadRef,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ClaudeCloudError({
                  detail:
                    "Could not acknowledge cloud ownership/delivery. Check the saved session; GOAT will not replay the prompt.",
                  outcome: "uncertain",
                  cause,
                }),
            ),
          );
        yield* saveThread(thread);
      });
      const settle = Effect.fn("ClaudeCloudAdapter.settle")(function* (
        i: Turn | Attach,
        error?: ClaudeCloudError,
        resultText?: string,
      ) {
        const at = yield* DateTime.now;
        const turnId = ProviderTurnId.make(`claudeCloud:${options.instanceId}:${i.attemptId}`);
        // RunExecutionService owns the sole atomic message:cloud-result:<run>.
        const turn: OrchestrationV2ProviderTurn = {
          id: turnId,
          providerThreadId: i.providerThread.id,
          nodeId: i.rootNodeId,
          runAttemptId: i.attemptId,
          nativeTurnRef: null,
          ordinal: i.providerTurnOrdinal,
          status: error ? "failed" : "completed",
          startedAt: turns.get(turnId)?.startedAt ?? at,
          completedAt: at,
        };
        turns.set(turnId, turn);
        yield* publish({
          type: "provider_turn.updated",
          driver: DRIVER,
          threadId: i.threadId,
          providerTurn: turn,
        });
        const failure = error
          ? makeProviderFailure({
              message: error.detail,
              class: "provider_error",
              code: error.outcome === "rejected" ? CLOUD_DELIVERY_REJECTED_CODE : null,
              retryable: false,
            })
          : null;
        if (failure)
          yield* publish({
            type: "turn_item.updated",
            driver: DRIVER,
            turnItem: makeProviderFailureTurnItem({
              driver: DRIVER,
              threadId: i.threadId,
              runId: i.runId,
              nodeId: i.rootNodeId,
              providerThreadId: i.providerThread.id,
              providerTurnId: turnId,
              itemOrdinal: 1,
              failure,
              occurredAt: at,
            }),
          });
        if (failure)
          yield* publish({
            type: "turn.terminal",
            driver: DRIVER,
            providerThreadId: i.providerThread.id,
            providerTurnId: turnId,
            runOrdinal: i.runOrdinal,
            status: "failed",
            failure,
            failureItemOrdinal: 1,
            threadDisposition: "reusable",
          });
        else
          yield* publish({
            type: "turn.terminal",
            driver: DRIVER,
            providerThreadId: i.providerThread.id,
            providerTurnId: turnId,
            runOrdinal: i.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
            ...(resultText === undefined ? {} : { resultText }),
          });
      });
      const failObservation = Effect.fn("ClaudeCloudAdapter.failObservation")(function* (
        i: Turn | Attach,
        thread: OrchestrationV2ProviderThread,
        error: ClaudeCloudError,
      ) {
        if (thread.cloudTask) {
          thread = {
            ...thread,
            status: "idle",
            updatedAt: yield* DateTime.now,
            cloudTask: {
              ...withoutFailureEvidence(thread.cloudTask),
              status: error.outcome === "uncertain" ? "unknown" : "failed",
              tracking: "polled",
              error: error.detail,
              summary: error.detail,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            },
          };
          // If ownership is unavailable, retain the last durable intent/ack. Recovery never replays it.
          yield* commit(i, thread).pipe(Effect.catch(() => saveThread(thread)));
        }
        if (error.outcome === "uncertain") yield* block(error.detail);
        yield* settle(i, error);
      });
      const current = (i: Turn | Attach) => threads.get(i.providerThread.id) ?? i.providerThread;
      const readSession = Effect.fn("ClaudeCloudAdapter.readSession")(function* (i: Turn | Attach) {
        const ref = current(i).nativeThreadRef;
        const login = yield* options.resolveLogin;
        if (!ref?.nativeId || ref.fingerprint !== login.binding)
          return yield* new ClaudeCloudError({
            detail: "The sibling Claude login changed, so GOAT will not read the session with it.",
            outcome: "uncertain",
          });
        return yield* cli.readSession(login, yield* options.resolveReadRoot, ref.nativeId);
      });
      const promptsSeen = new Map<string, number>();
      const anchor = Effect.fn("ClaudeCloudAdapter.anchor")(function* (
        i: Turn | Attach,
        followUp: boolean | undefined,
      ) {
        const history = yield* options.runHistory(i).pipe(Effect.result);
        const made = runAnchor({
          startedAt: yield* options.runStartedAt(i),
          history: history._tag === "Success" ? history.success : undefined,
          followUp,
          registered: current(i).cloudTask?.attach === "registered",
          ...("message" in i ? { message: i.message.text } : {}),
          seen: promptsSeen,
          key: i.providerThread.id,
        });
        return made ?? (yield* new ClaudeCloudError({ detail: UNKNOWN_RUN, outcome: "uncertain" }));
      });
      const observe = Effect.fn("ClaudeCloudAdapter.follow")(function* (
        i: Turn | Attach,
        followUp: boolean,
      ) {
        return yield* observeCloudSession({
          ...(yield* anchor(i, followUp)),
          thread: () => current(i),
          commit: (thread) => commit(i, thread),
          findPullRequest: () => {
            const task = current(i).cloudTask;
            return task?.url
              ? options.observe({
                  projectId: i.appThread.projectId,
                  repository: task.source.repository,
                  sessionUrl: task.url,
                })
              : Effect.fail(
                  new ClaudeCloudError({
                    detail: "The saved cloud task has no session link.",
                    outcome: "uncertain",
                  }),
                );
          },
          readSession: () => readSession(i),
        });
      });
      const finish = (i: Turn | Attach, outcome: Observation) =>
        outcome.kind === "replied"
          ? settle(i, undefined, outcome.text)
          : outcome.kind === "failed"
            ? settle(i, outcome.error)
            : settle(i);
      const run = Effect.fn("ClaudeCloudAdapter.run")(function* (i: Turn) {
        const previousTask = threads.get(i.providerThread.id)?.cloudTask;
        let thread = i.providerThread;
        threads.set(thread.id, thread);
        const at = yield* DateTime.now;
        const turnId = ProviderTurnId.make(`claudeCloud:${options.instanceId}:${i.attemptId}`);
        const started: OrchestrationV2ProviderTurn = {
          id: turnId,
          providerThreadId: thread.id,
          nodeId: i.rootNodeId,
          runAttemptId: i.attemptId,
          nativeTurnRef: null,
          ordinal: i.providerTurnOrdinal,
          status: "running",
          startedAt: at,
          completedAt: null,
        };
        turns.set(turnId, started);
        yield* publish({
          type: "provider_turn.updated",
          driver: DRIVER,
          threadId: i.threadId,
          providerTurn: started,
        });
        const operation = Effect.gen(function* () {
          if (!i.commitCloudTask)
            return yield* new ClaudeCloudError({
              detail: "Durable cloud intent is unavailable.",
              outcome: "rejected",
            });
          if (session.capabilities.sessions.followUp?.supported === false)
            return yield* new ClaudeCloudError({
              detail:
                session.capabilities.sessions.followUp.reason ??
                "Claude Cloud follow-ups are blocked.",
              outcome: "uncertain",
            });
          const ambiguous = (task: OrchestrationV2ProviderThread["cloudTask"]) =>
            task &&
            (task.status === "unknown" ||
              (thread.nativeThreadRef &&
                ((task.status === "failed" && !confirmedFailure(task)) ||
                  task.status === "cancelled")) ||
              (task.status === "submitting" &&
                (task.progress === "Submitting follow-up" ||
                  (!thread.nativeThreadRef && task.taskId !== i.runId))));
          if (
            (previousTask?.status === "submitting" && thread.nativeThreadRef) ||
            ambiguous(previousTask) ||
            ambiguous(thread.cloudTask)
          )
            return yield* new ClaudeCloudError({
              detail:
                thread.cloudTask?.error ??
                "Previous submission or delivery is uncertain. No prompt was sent.",
              outcome: "uncertain",
            });
          if (thread.driver !== DRIVER || thread.providerInstanceId !== options.instanceId)
            return yield* new ClaudeCloudError({
              detail:
                "The saved cloud thread belongs to a different provider instance. No prompt was sent.",
              outcome: "uncertain",
            });
          if (
            i.message.attachments.length ||
            i.modelSelection.model !== "cloud-default" ||
            i.modelSelection.instanceId !== options.instanceId ||
            i.runtimePolicy.interactionMode !== "default" ||
            i.runtimePolicy.runtimeMode !== "approval-required" ||
            i.runtimePolicy.reasoningEffort !== undefined ||
            Object.keys(i.modelSelection.options ?? {}).length
          )
            return yield* new ClaudeCloudError({
              detail:
                "Claude Cloud accepts text with Cloud default and normal interaction mode only.",
              outcome: "rejected",
            });
          const current = yield* options.resolveLogin;
          yield* Effect.try({
            try: () => validateLogin(current),
            catch: (cause) =>
              isClaudeCloudError(cause)
                ? cause
                : new ClaudeCloudError({
                    detail: "Could not validate the sibling Claude login.",
                    outcome: "rejected",
                    cause,
                  }),
          });
          const fingerprint = thread.nativeThreadRef?.fingerprint;
          if (
            (binding !== undefined && current.binding !== binding) ||
            (thread.nativeThreadRef && fingerprint !== current.binding)
          )
            return yield* new ClaudeCloudError({
              detail:
                "The sibling Claude login configuration changed. Restore the original configuration; GOAT will not rebind this session.",
              outcome: "rejected",
            });
          binding = current.binding;
          const nativeId = thread.nativeThreadRef?.nativeId;
          if (nativeId) {
            const prior = thread.cloudTask;
            const identity = yield* Effect.try({
              try: () => sessionUrl(prior?.url ?? ""),
              catch: (cause) =>
                new ClaudeCloudError({
                  detail: "The saved cloud session link is invalid. No follow-up was sent.",
                  outcome: "uncertain",
                  cause,
                }),
            });
            if (
              !prior ||
              !SESSION_ID.test(nativeId) ||
              prior.taskId !== nativeId ||
              identity.taskId !== nativeId ||
              thread.nativeThreadRef?.driver !== DRIVER
            )
              return yield* new ClaudeCloudError({
                detail: "The saved cloud identity is inconsistent; no follow-up was sent.",
                outcome: "uncertain",
              });
          }
          const controlCwd = yield* options.resolveControlCwd;
          // Read-only probes cannot deliver a prompt; their failure is a local rejection.
          yield* cli
            .readiness(current, controlCwd)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ClaudeCloudError({ detail: cause.detail, outcome: "rejected", cause }),
              ),
            );
          if (nativeId) {
            const prior = thread.cloudTask!;
            // Base intentionally passes status submitting for this run. It is not a prior-run rejection here.
            thread = {
              ...thread,
              cloudTask: {
                ...withoutFailureEvidence(prior),
                status: "submitting",
                tracking: "polled",
                progress: "Submitting follow-up",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            };
            yield* commit(i, thread);
            const reply = yield* cli
              .send(current, controlCwd, nativeId, i.message.text)
              .pipe(Effect.result);
            if (reply._tag === "Failure") {
              if (reply.failure.outcome === "uncertain") return yield* reply.failure;
              thread = {
                ...thread,
                status: "idle",
                updatedAt: yield* DateTime.now,
                cloudTask: {
                  ...withoutFailureEvidence(prior),
                  status: "running",
                  tracking: "polled",
                  progress: "Follow-up rejected",
                  summary: `Follow-up rejected: ${reply.failure.detail}`,
                  error: reply.failure.detail,
                  updatedAt: DateTime.formatIso(yield* DateTime.now),
                },
              };
              yield* commit(i, thread);
              yield* settle(i, reply.failure);
              return "settled" as const;
            }
            const retained = withoutFailureEvidence(prior);
            delete retained.prUrl;
            delete retained.branch;
            delete retained.summary;
            delete retained.error;
            thread = {
              ...thread,
              status: "idle",
              updatedAt: yield* DateTime.now,
              cloudTask: {
                ...retained,
                ...reply.success,
                status: "running",
                tracking: "polled",
                progress: FOLLOW_UP_ACCEPTED,
                summary:
                  "Follow-up accepted. This receipt confirms message admission, not completed work.",
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            };
            yield* commit(i, thread);
            return yield* observe(i, true);
          } else {
            if (thread.cloudTask?.status === "submitting" && thread.cloudTask.taskId !== i.runId)
              return yield* new ClaudeCloudError({
                detail: "Previous submission is ambiguous; no task was started.",
                outcome: "uncertain",
              });
            const launchSource = i.cloudLaunchSource;
            if (
              !i.cloudSource ||
              !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(
                i.cloudSource.repository,
              ) ||
              !i.cloudSource.branch.trim() ||
              !launchSource ||
              launchSource.restriction !== "project-folder" ||
              !launchSource.cwd.trim()
            )
              return yield* new ClaudeCloudError({
                detail: "Claude Cloud needs a GitHub project folder and its current branch.",
                outcome: "rejected",
              });
            // Read the durable deadline before any create; a missing deadline must not orphan a session.
            const originalStart = yield* options.runStartedAt(i);
            if (
              DateTime.toEpochMillis(originalStart) + OBSERVATION_WINDOW_MS <=
              DateTime.toEpochMillis(yield* DateTime.now)
            )
              return yield* new ClaudeCloudError({
                detail:
                  "The persisted cloud observation deadline has expired. No task was started.",
                outcome: "rejected",
              });
            thread = {
              ...thread,
              cloudTask: {
                taskId: i.runId,
                status: "submitting",
                tracking: "polled",
                source: i.cloudSource,
                localChangesExcluded: false,
                ...(thread.cloudTask?.localChangesIncluded === undefined
                  ? {}
                  : { localChangesIncluded: thread.cloudTask.localChangesIncluded }),
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              },
            };
            yield* commit(i, thread);
            const trustAllowed =
              options.folderTrust === undefined
                ? false
                : yield* options.folderTrust.allowed(launchSource.cwd);
            let trustPrompts = 0;
            const recordTrust = Effect.suspend(() =>
              trustPrompts === 0
                ? Effect.void
                : Effect.gen(function* () {
                    const at = yield* DateTime.now;
                    yield* publish({
                      type: "turn_item.updated",
                      driver: DRIVER,
                      turnItem: {
                        id: IdAllocator.derive.turnItemFromProviderItem({
                          driver: DRIVER,
                          nativeItemId: `folder-trust:${turnId}`,
                        }),
                        threadId: i.threadId,
                        runId: i.runId,
                        nodeId: i.rootNodeId,
                        providerThreadId: i.providerThread.id,
                        providerTurnId: turnId,
                        nativeItemRef: null,
                        parentItemId: null,
                        ordinal: 0,
                        status: "completed",
                        title: "Folder trusted",
                        startedAt: at,
                        completedAt: at,
                        updatedAt: at,
                        type: "system_notice",
                        message: `Claude Code asked to trust ${launchSource.cwd}. GOAT accepted it automatically.`,
                      },
                    });
                    yield* options.folderTrust!.record({
                      cwd: launchSource.cwd,
                      threadId: i.threadId,
                      prompts: trustPrompts,
                    });
                  }),
            );
            yield* Effect.scoped(
              Effect.gen(function* () {
                const handle = yield* cli
                  .start(
                    current,
                    launchSource.cwd,
                    i.message.text,
                    trustAllowed
                      ? {
                          ...(options.folderTrust?.accept === undefined
                            ? {}
                            : { accept: options.folderTrust.accept(launchSource.cwd) }),
                          onAccepted: () => {
                            trustPrompts += 1;
                          },
                        }
                      : undefined,
                  )
                  .pipe(Effect.ensuring(recordTrust));
                const now = yield* DateTime.now;
                thread = {
                  ...thread,
                  status: "active",
                  updatedAt: now,
                  nativeThreadRef: {
                    driver: DRIVER,
                    nativeId: handle.receipt.taskId,
                    strength: "strong",
                    fingerprint: current.binding,
                  },
                  cloudTask: {
                    ...thread.cloudTask!,
                    ...handle.receipt,
                    status: "running",
                    tracking: "polled",
                    progress: "Running in the cloud",
                    updatedAt: DateTime.formatIso(now),
                  },
                };
                yield* commit(i, thread);
                yield* handle.exited;
              }),
            );
            return yield* observe(i, false);
          }
        });
        yield* operation.pipe(
          Effect.flatMap((result) => (result === "settled" ? Effect.void : finish(i, result))),
          Effect.catch((error) => {
            const observed = threads.get(thread.id);
            const saved =
              (thread.nativeThreadRef && !observed?.nativeThreadRef) ||
              (thread.cloudTask && !observed?.cloudTask)
                ? thread
                : (observed ?? thread);
            // A pre-send rejection preserves a known session; a failed acknowledgement is uncertain.
            if (error.outcome === "rejected" && saved.nativeThreadRef && saved.cloudTask)
              return Effect.gen(function* () {
                yield* commit(i, {
                  ...saved,
                  cloudTask: {
                    ...withoutFailureEvidence(saved.cloudTask!),
                    status: "running",
                    progress: "Follow-up rejected",
                    summary: `Follow-up rejected: ${error.detail}`,
                    error: error.detail,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  },
                });
                yield* settle(i, error);
              }).pipe(Effect.catch((uncertain) => failObservation(i, saved, uncertain)));
            return failObservation(i, saved, error);
          }),
        );
      });
      const ensureThread: Adapter.ProviderAdapterV2SessionRuntime["ensureThread"] = (ensure) =>
        Effect.gen(function* () {
          if (ensure.existingProviderThread) {
            threads.set(ensure.existingProviderThread.id, ensure.existingProviderThread);
            return ensure.existingProviderThread;
          }
          const created = yield* DateTime.now;
          const thread: OrchestrationV2ProviderThread = {
            id: ProviderThreadId.make(`claudeCloud:${options.instanceId}:${ensure.threadId}`),
            driver: DRIVER,
            providerInstanceId: options.instanceId,
            providerSessionId: session.id,
            appThreadId: ensure.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            goal: null,
            createdAt: created,
            updatedAt: created,
          };
          threads.set(thread.id, thread);
          return thread;
        });
      return {
        instanceId: options.instanceId,
        driver: DRIVER,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromPubSub(bus),
        subscribeEvents: Effect.gen(function* () {
          const subscriptionScope = yield* Scope.make();
          const close = Scope.close(subscriptionScope, Exit.void);
          yield* Scope.addFinalizer(scope, close);
          const subscription = yield* PubSub.subscribe(bus).pipe(
            Effect.provideService(Scope.Scope, subscriptionScope),
          );
          return { events: Stream.fromSubscription(subscription), close };
        }),
        ensureThread,
        resumeThread: ({ providerThread }) =>
          Effect.sync(() => {
            threads.set(providerThread.id, providerThread);
            return providerThread;
          }),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            if (begun.has(turnInput.runId)) return;
            begun.add(turnInput.runId);
            yield* run(turnInput).pipe(lock.withPermits(1), Effect.forkIn(scope));
          }),
        resumeTurn: (i) =>
          Effect.gen(function* () {
            if (begun.has(i.runId)) return;
            begun.add(i.runId);
            yield* Effect.gen(function* () {
              const thread = { ...i.providerThread, cloudTask: i.cloudTask };
              threads.set(thread.id, thread);
              const task = i.cloudTask;
              const failure = confirmedFailure(task);
              const identity = yield* Effect.try({
                try: () => sessionUrl(task.url ?? ""),
                catch: (cause) =>
                  new ClaudeCloudError({
                    detail: "Saved cloud session link is invalid; no prompt was replayed.",
                    outcome: "uncertain",
                    cause,
                  }),
              }).pipe(Effect.result);
              if (
                identity._tag === "Failure" ||
                (identity._tag === "Success" && identity.success.taskId !== task.taskId) ||
                thread.nativeThreadRef?.driver !== DRIVER ||
                task.status === "submitting" ||
                task.status === "unknown" ||
                !SESSION_ID.test(task.taskId) ||
                thread.nativeThreadRef?.nativeId !== task.taskId ||
                (task.status === "failed" && !failure) ||
                task.status === "cancelled"
              ) {
                yield* failObservation(
                  i,
                  thread,
                  new ClaudeCloudError({
                    outcome: "uncertain",
                    detail:
                      task.error ??
                      "Current-prompt admission is unknown after restart. No prompt was replayed.",
                    ...(identity._tag === "Failure" ? { cause: identity.failure } : {}),
                  }),
                );
                return;
              }
              // The run's own prompt failed for certain; settle it again, as the session left it.
              if (failure) return yield* settle(i, failure);
              if (task.status === "succeeded") {
                // A session reply has a summary; a PR result also has its PR and branch.
                if (!task.summary || !task.prUrl !== !task.branch)
                  return yield* failObservation(
                    i,
                    thread,
                    new ClaudeCloudError({
                      outcome: "uncertain",
                      detail: "Saved cloud result is incomplete; open the session.",
                    }),
                  );
                // A crash between the result and its terminal kept only the cut summary.
                const text = isShortenedReply(task)
                  ? yield* anchor(i, undefined).pipe(
                      Effect.flatMap((runAnchor) =>
                        recoverCloudReply({ ...runAnchor, readSession: () => readSession(i) }),
                      ),
                      Effect.orElseSucceed(() => undefined),
                    )
                  : undefined;
                yield* settle(i, undefined, text);
                return;
              }
              if (task.progress === "Follow-up rejected") {
                if (!task.summary)
                  yield* commit(i, {
                    ...thread,
                    cloudTask: {
                      ...task,
                      summary: `Follow-up rejected: ${task.error ?? "No message admission was confirmed."}`,
                    },
                  });
                yield* settle(
                  i,
                  new ClaudeCloudError({
                    outcome: "rejected",
                    detail: task.error ?? "Follow-up rejected.",
                  }),
                );
                return;
              }
              yield* observe(i, task.progress?.startsWith(FOLLOW_UP_ACCEPTED) === true).pipe(
                Effect.flatMap((outcome) => finish(i, outcome)),
                Effect.catch((error) =>
                  failObservation(i, threads.get(thread.id) ?? thread, error),
                ),
              );
            }).pipe(
              Effect.catch((error) =>
                failObservation(i, threads.get(i.providerThread.id) ?? i.providerThread, error),
              ),
              lock.withPermits(1),
              Effect.forkIn(scope),
            );
          }),
        steerTurn: ({ providerThread }) =>
          Effect.fail(
            new Adapter.ProviderAdapterSteerRunUnsupportedError({
              driver: DRIVER,
              providerThreadId: providerThread.id,
            }),
          ),
        interruptTurn: () => unsupported(CANCEL_REASON),
        respondToRuntimeRequest: () =>
          unsupported(
            "Claude Cloud approval and trust decisions must be made in Claude, not GOAT.",
          ),
        readThreadSnapshot: ({ providerThread }) =>
          Effect.succeed({
            providerThread: threads.get(providerThread.id) ?? providerThread,
            providerTurns: [...turns.values()].filter(
              (turn) => turn.providerThreadId === providerThread.id,
            ),
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: () => unsupported("Claude Cloud does not support GOAT rollback."),
        forkThread: () => unsupported("Claude Cloud does not support GOAT thread forks."),
      } satisfies Adapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
