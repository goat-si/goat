import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ThreadReplicaService from "./ThreadReplicaService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadSendDelivered,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderThreadId,
  ProviderTurnId,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@goat/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as LaunchWatchService from "./LaunchWatchService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { layerPermissionProfilesOff } from "./McpToolAccess.testkit.ts";

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}
function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(layerPermissionProfilesOff),
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);

// Sends within one environment are always delivered here, never relayed.
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendDelivered);
const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(yield* path.fromFileUrl(delegatedTaskStatusTranscriptFile));
  return yield* decodeProviderReplayNdjson(text.replaceAll(queuedFollowupResult, followupResult));
}, Effect.provide(NodeServices.layer));

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
  readonly terminalGate?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Deferred.Deferred<void> | undefined;
  readonly detachedCompletion?: boolean;
  readonly startEvents?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>>;
  readonly onRespond?: (
    response: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void>;
  readonly response: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => string;
  readonly steerReceived?: (
    steer: ProviderAdapter.ProviderAdapterV2SteerInput,
  ) => Deferred.Deferred<void> | undefined;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const sessionScope = yield* Effect.scope;
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TurnInput>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              if (input.startEvents !== undefined)
                yield* publish(yield* input.startEvents(turnInput, providerTurnId));
              const complete = Effect.gen(function* () {
                const terminalGate = input.terminalGate?.(turnInput);
                if (terminalGate !== undefined) {
                  yield* Deferred.await(terminalGate);
                } else if (!input.shouldComplete(turnInput)) {
                  return;
                }
                const response = input.response(turnInput);
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: turnInput.providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "completed",
                      startedAt: eventTime,
                      completedAt: eventTime,
                    },
                  },
                  {
                    type: "turn_item.updated",
                    driver: input.driver,
                    turnItem: {
                      id: TurnItemId.make(
                        `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      threadId: turnInput.threadId,
                      runId: turnInput.runId,
                      nodeId: turnInput.rootNodeId,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: turnInput.runOrdinal * 100 + 1,
                      status: "completed",
                      title: null,
                      startedAt: eventTime,
                      completedAt: eventTime,
                      updatedAt: eventTime,
                      type: "assistant_message",
                      messageId: MessageId.make(
                        `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                      ),
                      text: response,
                      streaming: false,
                    },
                  },
                  {
                    type: "turn.terminal",
                    driver: input.driver,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    runOrdinal: turnInput.runOrdinal,
                    status: "completed",
                    failure: null,
                    threadDisposition: "reusable",
                  },
                ]);
              });
              if (input.detachedCompletion === true)
                yield* complete.pipe(Effect.forkIn(sessionScope));
              else yield* complete;
            }),
          steerTurn: (steer) => {
            const received = input.steerReceived?.(steer);
            return received === undefined
              ? Effect.void
              : Deferred.succeed(received, undefined).pipe(Effect.asVoid);
          },
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: (response) => input.onRespond?.(response) ?? Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

describe("orchestrator MCP toolkit", () => {
  it.live("steers a child follow-up into its running turn from a Codex replay transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(queuedFollowupResult);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provide(
            ThreadResultService.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(
            Layer.mock(LaunchWatchService.LaunchWatchService)({
              find: () => Effect.succeed(null),
              rearm: () => Effect.void,
            }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
          ),
          Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          if (delegated.childThreadId === null)
            return yield* Effect.die("Local delegation must return a child thread");
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();
          expect(delegated.latestTerminalResultContextTransferId).toBeNull();

          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("goat_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(1);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([runningFollowup.taskId]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const steeredFollowupCall = yield* invoke("goat_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const steeredFollowup = yield* decodeThreadSendResult(
            steeredFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(steeredFollowup).toMatchObject({
            delivery: "steered",
            runId: runningFollowup.runId,
            taskId: runningFollowup.taskId,
          });

          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === runningFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Steered follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(finalProjection.runs.map((run) => run.id)).toEqual([
            delegated.childRunId,
            runningFollowup.runId,
          ]);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[0]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.filter(
              (task) =>
                task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
            ),
          ).toHaveLength(1);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id),
          ).toMatchObject({
            status: "completed",
            result: queuedFollowupResult,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(2);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: runningFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: queuedFollowupResult,
          });
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBeNull();
          const read = yield* invoke("goat_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === runningFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );

  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provide(
            ThreadResultService.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(
            Layer.mock(LaunchWatchService.LaunchWatchService)({
              find: () => Effect.succeed(null),
              rearm: () => Effect.void,
            }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
          ),
          Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          if (delegated.childThreadId === null)
            return yield* Effect.die("Delegated child was not created");
          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("goat_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(1);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([runningFollowup.taskId]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const steeredFollowupCall = yield* invoke("goat_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const steeredFollowup = yield* decodeThreadSendResult(
            steeredFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(steeredFollowup).toMatchObject({
            delivery: "steered",
            runId: runningFollowup.runId,
            taskId: runningFollowup.taskId,
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === runningFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Steered follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(finalProjection.runs.map((run) => run.id)).toEqual([
            delegated.childRunId,
            runningFollowup.runId,
          ]);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[0]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.filter(
              (task) =>
                task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
            ),
          ).toHaveLength(1);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(2);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: runningFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === runningFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const read = yield* invoke("goat_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === runningFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});

it.live("delegate_task wait returns before a child question is answered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("question-wait");

      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const answered = yield* Deferred.make<void>();
      const offered = yield* Deferred.make<void>();
      const offers = yield* Ref.make<
        ReadonlyArray<ProviderContinuationRequests.ProviderContinuationRequest>
      >([]);
      const continuationProbe = Layer.succeed(
        ProviderContinuationRequests.ProviderContinuationRequests,
        {
          offer: (request) =>
            Ref.update(offers, (all) => [...all, request]).pipe(
              Effect.andThen(Deferred.succeed(offered, undefined)),
              Effect.asVoid,
            ),
          take: Effect.never,
        },
      );
      const requestId = RuntimeRequestId.make("live-child-question");
      const answerValues: Array<ProviderUserInputAnswers | undefined> = [];
      const driver = ProviderDriverKind.make("codex");
      const adapter = makeDeterministicAdapter({
        instanceId: codexInstanceId,
        driver,
        capabilities: CodexProviderCapabilitiesV2,
        capturedTurns,
        shouldComplete: () => false,
        detachedCompletion: true,
        terminalGate: (turn) =>
          turn.message.text === "Ask before deciding." ? answered : undefined,
        response: () => "Answered and completed.",
        onRespond: (response) =>
          Effect.gen(function* () {
            answerValues.push(response.answers);
            yield* Deferred.succeed(answered, undefined);
          }),
        startEvents: (turn, providerTurnId) =>
          Effect.gen(function* () {
            if (turn.message.text !== "Ask before deciding.") return [];
            const now = yield* DateTime.now;
            const nodeId = NodeId.make("live-child-question-node");
            const providerSessionId = turn.providerThread.providerSessionId;
            if (providerSessionId === null) return yield* Effect.die("Missing provider session");
            const events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
              {
                type: "node.updated",
                driver,
                node: {
                  id: nodeId,
                  threadId: turn.threadId,
                  runId: turn.runId,
                  parentNodeId: turn.rootNodeId,
                  rootNodeId: turn.rootNodeId,
                  kind: "user_input_request",
                  status: "waiting",
                  countsForRun: true,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  runtimeRequestId: requestId,
                  checkpointScopeId: null,
                  startedAt: now,
                  completedAt: null,
                },
              },
              {
                type: "runtime_request.updated",
                driver,
                threadId: turn.threadId,
                runtimeRequest: {
                  id: requestId,
                  nodeId,
                  providerTurnId,
                  nativeRequestRef: { driver, nativeId: "question-native", strength: "strong" },
                  kind: "user_input",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId },
                  createdAt: now,
                  resolvedAt: null,
                },
              },
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make("live-child-question-item"),
                  type: "user_input_request",
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 2,
                  status: "waiting",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  requestId,
                  questions: [
                    {
                      id: "q",
                      header: "Choice",
                      question: "Choose a branch?",
                      options: [
                        { label: "dev", description: "Development" },
                        { label: "main", description: "Stable" },
                      ],
                    },
                  ],
                },
              },
            ];
            return events;
          }),
      });
      const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
      const runtime = ProviderReplayHarness.layerWithRegistry(
        { name: "question-wait", runtimePolicyOverride: { cwd } },
        registry,
      ).pipe(Layer.provide(continuationProbe));
      const orchestration = Layer.merge(
        runtime,
        ThreadManagementService.layer.pipe(
          Layer.provide(runtime),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(
            CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      );
      const layer = Layer.merge(
        layerOrchestratorToolkit,
        McpHttpServer.layerThreadToolkit.pipe(
          Layer.provide(layerPermissionProfilesOff),
          Layer.provide(layerNoFleetSync),
        ),
      ).pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(ThreadResultService.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(orchestration),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(registry),
        Layer.provide(
          ProviderRegistryMock.layer([
            makeProviderSnapshot({ instanceId: codexInstanceId, driver, model: codexModel }),
          ]),
        ),
        Layer.provide(layerUnusedScheduledTaskStub),
        Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
        Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
        Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
        Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
        Layer.provide(
          Layer.mock(LaunchWatchService.LaunchWatchService)({
            find: () => Effect.succeed(null),
            rearm: () => Effect.void,
          }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
        ),
        Layer.provide(
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({ connectedHosts: Effect.succeed([]) }),
        ),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const server = yield* McpServer.McpServer;
        const parentId = ThreadId.make("question-wait-parent");

        const created = yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("question-wait-create"),
          threadId: parentId,
          projectId,
          title: "Parent",
          modelSelection: codexSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("question-wait-start"),
          threadId: parentId,
          messageId: MessageId.make("question-wait-start"),
          text: parentPrompt,
          attachments: [],
          modelSelection: codexSelection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentId,
            afterSequence: created.sequence,
            eventType: "provider-turn.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
          );

        const invocation: McpInvocationContext.McpInvocationScope = {
          environmentId: EnvironmentId.make("question-wait-env"),
          requestNamespace: "question-wait",
          thread: {
            threadId: parentId,
            providerInstanceId: codexInstanceId,
            providerSessionId: "question-wait",
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        const invoke = (name: string, args: Record<string, unknown>) =>
          server
            .callTool({ name, arguments: args })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );

        const call = yield* invoke("delegate_task", {
          task: "Ask before deciding.",
          mode: "wait",
          timeoutMs: 10_000,
          clientRequestId: "question-wait",
        });
        expect(call.isError).not.toBe(true);

        const delegated = yield* decodeDelegateTaskResult(call.structuredContent);
        expect(delegated).toMatchObject({
          status: "running",
          waitTimedOut: false,
          pendingRequestIds: [requestId],
        });
        const parent = yield* orchestrator.getThreadRecords(parentId, ["subagents"]);
        expect(parent.subagents.find((task) => task.id === delegated.taskId)?.completionWake).toBe(
          "always",
        );
        const wait = yield* invoke("goat_thread_wait", { threadId: delegated.childThreadId });
        expect(wait.structuredContent).toMatchObject({
          timedOut: false,
          pendingRequestIds: [requestId],
        });
        const read = yield* invoke("goat_pending_request_read", {
          threadId: delegated.childThreadId,
          requestId,
        });
        expect(read.structuredContent).toMatchObject({ status: "pending", requestId });

        if (delegated.childThreadId === null) throw new Error("Expected a local child thread");
        const beforeAnswer = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);

        const response = yield* invoke("goat_pending_request_respond", {
          threadId: delegated.childThreadId,
          requestId,
          answers: { q: "dev" },
          reason: "The feature targets development.",
        });
        expect(response.isError).not.toBe(true);
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: delegated.childThreadId,
            afterSequence: beforeAnswer,
            eventType: "run.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" && stored.event.payload.status === "completed",
            ),
            Stream.runHead,
          );

        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();

        expect(answerValues).toEqual([{ q: "dev" }]);
        const child = yield* orchestrator.getThreadRecords(delegated.childThreadId, [
          "runtimeRequests",
        ]);
        expect(child.runtimeRequests.find((request) => request.id === requestId)).toMatchObject({
          status: "resolved",
          respondedBy: {
            type: "agent",
            threadId: parentId,
            environmentId: null,
            reason: "The feature targets development.",
          },
        });
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentId,
            afterSequence: beforeAnswer,
            eventType: "subagent.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === delegated.taskId &&
                (stored.event.payload.completionDelivery?.state === "claimed" ||
                  stored.event.payload.completionDelivery?.state === "delivered"),
            ),
            Stream.runHead,
          );
        yield* Deferred.await(offered);
        const finished = yield* orchestrator.getThreadRecords(parentId, ["subagents", "runs"]);
        expect(
          finished.subagents.find((task) => task.id === delegated.taskId)?.completionWake,
        ).toBe("always");
        const completions = yield* Ref.get(offers);
        expect(completions).toHaveLength(1);
        const delivery = finished.runs.flatMap((run) =>
          run.delegatedCompletion?.delivery === null ||
          run.delegatedCompletion?.delivery === undefined
            ? []
            : [run.delegatedCompletion.delivery],
        );
        expect(delivery).toHaveLength(1);
        expect(delivery[0]?.taskIds).toEqual([delegated.taskId]);
        expect(completions[0]?.delegatedCompletion?.messageId).toBe(delivery[0]?.messageId);
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("goat_thread_wait host result retains pendingRequestIds through MCP registration", () =>
  Effect.gen(function* () {
    const calls: Array<SshRemoteDispatch.SshHostToolCall> = [];
    const layer = layerOrchestratorToolkit.pipe(
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(LaunchWatchService.LaunchWatchService)({
          find: () => Effect.succeed(null),
        }).pipe(Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({}))),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(Layer.mock(ThreadManagementService.ThreadManagementService)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(ProviderRegistryMock.layer([])),
      Layer.provide(layerUnusedScheduledTaskStub),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          callHostTool: (call, authorize) =>
            authorize.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  calls.push(call);
                  return {
                    threadId: "remote",
                    runId: "remote-run",
                    status: "completed",
                    timedOut: false,
                    pendingRequestIds: ["remote-question"],
                  };
                }),
              ),
            ),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const invocation: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("host-wait"),
        requestNamespace: "client",
        thread: undefined,
        client: { sessionId: "client", label: "Outside", access: "full-access" },
        issuedAt: 0,
        capabilities: new Set(["orchestration"]),
      };
      const result = yield* server
        .callTool({ name: "goat_thread_wait", arguments: { host: "box", threadId: "remote" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(yield* decodeThreadWaitResult(result.structuredContent)).toMatchObject({
        host: "box",
        timedOut: false,
        pendingRequestIds: ["remote-question"],
      });
      expect(calls[0]?.arguments).not.toHaveProperty("host");
      expect(calls[0]?.writes).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);
