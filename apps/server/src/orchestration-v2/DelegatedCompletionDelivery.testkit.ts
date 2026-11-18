import { fromRunner } from "@goat/provider-core/server/textGenerationOperations";
import { applyToProjection } from "./projectionReducer.ts";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2PendingBackgroundTask,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);

const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "goat-orchestration-v2-delegated-completion-",
});

export const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;

const layerVcsDriverRegistryTest = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(layerServerConfig),
  Layer.provide(layerPlatformTest),
);

const layerCheckpointStoreTest = CheckpointStore.layer.pipe(
  Layer.provide(layerVcsDriverRegistryTest),
);

export const driver = ProviderDriverKind.make("codex");
const orchestrationAdapter = {
  instanceId: modelSelection.instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("sessions are not used by delegated completion tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: {
    driverKind: driver,
    continuationKey: "codex:test",
  },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter,
  textGeneration: fromRunner("fixture", () => Effect.die("Unexpected generation.")),
} satisfies ProviderInstance;

const layerTestProviderInstanceRegistry = Layer.succeed(
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  {
    getInstance: (instanceId) =>
      Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
    listInstances: Effect.succeed([providerInstance]),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.never,
  },
);

export const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
  EffectOutbox.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      awaitRepositoryIdentity: () => Effect.succeed(null),
      refreshRepositoryIdentity: () => Effect.void,
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerPlatformTest),
);

export const seedParentWithTerminalTask = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly taskId: NodeId;
  readonly deliveryState: "pending" | "delivered" | "claimed" | "acknowledged" | "disposed";
  readonly completionWake?: "always" | "settled_only";
  readonly remote?: boolean;
  readonly deliveryTaskIds?: ReadonlyArray<NodeId>;
  readonly parentRunStatus?: "running" | "completed";
  readonly siblingTasks?: ReadonlyArray<{
    readonly id: NodeId;
    readonly deliveryState: "delivered" | "claimed" | "acknowledged" | "disposed";
  }>;
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const providerThreadId = ProviderThreadId.make(
      `provider-thread:${String(input.threadId).replace("thread:", "")}`,
    );

    yield* projects.create({
      commandId: CommandId.make(`command:seed-project:${input.threadId}`),
      projectId: input.projectId,
      title: "Delegated completion delivery",
      workspaceRoot: `/workspace/${input.projectId}`,
    });

    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-create:${input.threadId}`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Delegated completion delivery",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });

    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-projection:${input.threadId}`),
      events: [
        {
          id: EventId.make(`event:seed-provider-thread:${input.threadId}`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: input.rootNodeId,
            nativeThreadRef: {
              driver,
              nativeId: `native:${input.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: input.now,
            updatedAt: input.now,
          },
        },
        {
          id: EventId.make(`event:seed-run:${input.threadId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: input.runId,
          nodeId: input.rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`message:seed-user:${input.threadId}`),
            rootNodeId: input.rootNodeId,
            activeAttemptId: null,
            status: input.parentRunStatus ?? "running",
            requestedAt: input.now,
            startedAt: input.now,
            completedAt: input.parentRunStatus === "completed" ? input.now : null,
            checkpointId: null,
            contextHandoffId: null,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery:
                input.deliveryTaskIds === undefined
                  ? null
                  : {
                      generation: 1,
                      messageId: MessageId.make(`message:delegated-delivery:${input.threadId}`),
                      taskIds: input.deliveryTaskIds,
                    },
            },
          },
        },
        ...[
          { id: input.taskId, deliveryState: input.deliveryState },
          ...(input.siblingTasks ?? []),
        ].map((task) => ({
          id: EventId.make(`event:seed-task:${input.threadId}:${task.id}`),
          type: "subagent.updated" as const,
          threadId: input.threadId,
          runId: input.runId,
          nodeId: task.id,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: task.id,
            threadId: input.threadId,
            runId: input.runId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned" as const,
            createdBy: "agent" as const,
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId: null,
            ...(input.remote
              ? {
                  remote: {
                    host: "box",
                    threadId: ThreadId.make("remote-child"),
                    correlationId: "rr-mailbox",
                  },
                }
              : {}),
            nativeTaskRef: null,
            prompt: "Inspect the delivered ownership edge.",
            title: null,
            model: null,
            completionWake: input.completionWake ?? "settled_only",
            completionDelivery: {
              state: task.deliveryState,
              observedByRunId: task.deliveryState === "acknowledged" ? input.runId : null,
            },
            status: "completed" as const,
            result: "child finished",
            startedAt: input.now,
            completedAt: input.now,
            updatedAt: input.now,
          },
        })),
      ],
    });
  });

export const reconcileCommandId = (name: string) =>
  CommandId.make(`command:runtime-reconcile:${name}`);

export const parentProviderThreadId = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${String(threadId).replace("thread:", "")}`);

export const runEvent = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly now: DateTime.Utc;
  readonly providerThreadId?: ProviderThreadId;
  readonly userMessageId?: MessageId;
  readonly delegatedCompletion?: OrchestrationV2Run["delegatedCompletion"];
}) => ({
  id: EventId.make(`event:${input.runId}:${input.status}`),
  type: "run.updated" as const,
  threadId: input.threadId,
  runId: input.runId,
  providerInstanceId: modelSelection.instanceId,
  occurredAt: input.now,
  payload: {
    id: input.runId,
    threadId: input.threadId,
    ordinal: input.ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: input.providerThreadId ?? null,
    userMessageId: input.userMessageId ?? MessageId.make(`message:${input.runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: input.status,
    requestedAt: input.now,
    startedAt: input.now,
    completedAt: input.status === "running" ? null : input.now,
    checkpointId: null,
    contextHandoffId: null,
    ...(input.delegatedCompletion === undefined
      ? {}
      : { delegatedCompletion: input.delegatedCompletion }),
  },
});

export const seedRestartCancelledChild = (input: {
  readonly parentThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentRunId: RunId;
  readonly rootNodeId: NodeId;
  readonly name: string;
  readonly completionWake: "always" | "settled_only";
  readonly continuationPending: boolean;
  readonly runStatus?: "cancelled" | "completed";
  readonly lostWork?: OrchestrationV2Run["restartCancelledBackgroundWork"];
  readonly now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const taskId = NodeId.make(`node:${input.name}`);
    const childThreadId = ThreadId.make(`thread:${input.name}`);
    const childRunId = RunId.make(`run:${input.name}:1`);
    yield* eventSink.write({
      commandId: CommandId.make(`command:seed-child:${input.name}`),
      events: [
        {
          id: EventId.make(`event:${input.name}:thread`),
          type: "thread.created",
          threadId: childThreadId,
          occurredAt: input.now,
          payload: {
            createdBy: "agent",
            creationSource: "server",
            id: childThreadId,
            projectId: input.projectId,
            title: input.name,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: input.parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: input.parentThreadId,
            },
            forkedFrom: { type: "node", nodeId: taskId },
            createdAt: input.now,
            updatedAt: input.now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        },
        {
          id: EventId.make(`event:${input.name}:task`),
          type: "subagent.updated",
          threadId: input.parentThreadId,
          runId: input.parentRunId,
          nodeId: taskId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: input.now,
          payload: {
            id: taskId,
            threadId: input.parentThreadId,
            runId: input.parentRunId,
            parentNodeId: input.rootNodeId,
            origin: "app_owned",
            createdBy: "agent",
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerThreadId: null,
            childThreadId,
            nativeTaskRef: null,
            prompt: `Run ${input.name}.`,
            title: null,
            model: null,
            completionWake: input.completionWake,
            status: "running",
            result: null,
            startedAt: input.now,
            completedAt: null,
            updatedAt: input.now,
          },
        },
      ],
    });
    const childRun = runEvent({
      threadId: childThreadId,
      runId: childRunId,
      ordinal: 1,
      status: input.runStatus ?? "cancelled",
      now: input.now,
    });
    yield* eventSink.writeWithEffects({
      commandId: reconcileCommandId(input.name),
      events: [
        input.lostWork === undefined
          ? childRun
          : {
              ...childRun,
              payload: { ...childRun.payload, restartCancelledBackgroundWork: input.lostWork },
            },
      ],
      effects: input.continuationPending
        ? [
            {
              id: `effect:restart-continuation:${childRunId}`,
              commandId: reconcileCommandId(input.name),
              threadId: childThreadId,
              request: { type: "provider-runtime.continue", sourceRunId: childRunId },
            },
          ]
        : [],
    });
    return { taskId, childThreadId, childRunId };
  });

export const seedBoundedDeliveryHistory = Effect.fn("seedBoundedDeliveryHistory")(function* (
  sink: EventSink.EventSinkV2["Service"],
  now: DateTime.Utc,
) {
  const threadId = ThreadId.make("thread:bounded-delivery-recovery");
  const runId = RunId.make("run:bounded-delivery-recovery");
  const taskId = NodeId.make("task:bounded-delivery-recovery");
  yield* seedParentWithTerminalTask({
    threadId,
    runId,
    taskId,
    projectId: ProjectId.make("project:bounded-delivery-recovery"),
    rootNodeId: NodeId.make("node:bounded-delivery-recovery"),
    deliveryState: "claimed",
    deliveryTaskIds: [taskId],
    completionWake: "always",
    now,
  });
  for (const suffix of ["first", "second"]) {
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:bounded-delivery-history:${suffix}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:bounded-delivery-history:${suffix}`),
            threadId,
            runId: null,
            nodeId: null,
            createdBy: "user",
            creationSource: "web",
            role: "user",
            text: "Unrelated historical input",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  }
  return runId;
});

export const seedUnheldFollowup = Effect.fn("seedUnheldFollowup")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:held-followup-parent");
  const projectId = ProjectId.make("project:held-followup");
  const runId = RunId.make("run:held-followup-parent");
  const rootNodeId = NodeId.make("node:held-followup-parent");
  yield* seedParentWithTerminalTask({
    threadId,
    projectId,
    runId,
    rootNodeId,
    taskId: NodeId.make("node:held-followup-seed"),
    deliveryState: "acknowledged",
    now,
  });
  const child = yield* seedRestartCancelledChild({
    parentThreadId: threadId,
    projectId,
    parentRunId: runId,
    rootNodeId,
    name: "held-followup-child",
    completionWake: "always",
    continuationPending: false,
    now,
  });
  yield* orchestrator.recoverDelegatedTasks;
  const parent = yield* orchestrator.getThreadProjection(threadId);
  const original = parent.subagents.find((task) => task.id === child.taskId);
  if (original === undefined) return yield* Effect.die("Original delegated task is missing");
  const taskId = NodeId.make("node:held-followup");
  const held = runEvent({
    threadId: child.childThreadId,
    runId: RunId.make("run:held-followup"),
    ordinal: 2,
    status: "queued",
    now,
  });
  yield* sink.write({
    commandId: reconcileCommandId("held-followup"),
    events: [
      {
        ...held,
        payload: {
          ...held.payload,
          delegatedTaskId: taskId,
          startedAt: null,
          completedAt: null,
          queueHeld: false,
        },
      },
      {
        id: EventId.make("event:held-followup-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        occurredAt: now,
        payload: {
          ...original,
          id: taskId,
          status: "pending",
          result: null,
          completedAt: null,
          completionDelivery: { state: "pending", observedByRunId: null },
        },
      },
    ],
  });
  return { sink, orchestrator, threadId, taskId, childThreadId: child.childThreadId };
});

export const recoverChildWithIndependentParentWake = Effect.fn(
  "recoverChildWithIndependentParentWake",
)(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:reoffer");
  const projectId = ProjectId.make("project:reoffer");
  const unrelatedRunId = RunId.make("run:reoffer:unrelated");
  const ownerRunId = RunId.make("run:reoffer:owner");
  const unrelatedTaskId = NodeId.make("node:reoffer:unrelated");
  const rootNodeId = NodeId.make("node:reoffer:owner");
  yield* seedParentWithTerminalTask({
    threadId,
    projectId,
    rootNodeId,
    runId: unrelatedRunId,
    taskId: unrelatedTaskId,
    deliveryState: "claimed",
    deliveryTaskIds: [unrelatedTaskId],
    completionWake: "always",
    now,
  });
  const child = yield* seedRestartCancelledChild({
    parentThreadId: threadId,
    projectId,
    parentRunId: ownerRunId,
    rootNodeId,
    name: "reoffer-child",
    completionWake: "always",
    continuationPending: false,
    now,
  });
  const owner = runEvent({
    threadId,
    runId: ownerRunId,
    ordinal: 2,
    status: "completed",
    now,
    providerThreadId: parentProviderThreadId(threadId),
    delegatedCompletion: {
      disposition: "open",
      nextGeneration: 2,
      delivery: {
        generation: 1,
        messageId: MessageId.make("message:reoffer:owner"),
        taskIds: [child.taskId],
      },
    },
  });
  yield* sink.write({ commandId: reconcileCommandId("reoffer-owner"), events: [owner] });
  const control = yield* orchestrator.getThreadProjection(child.childThreadId);
  const sourceRun = control.runs.at(-1);
  if (sourceRun === undefined) return yield* Effect.die("Child run missing");
  yield* orchestrator.recoverDelegatedTask(child.childThreadId, { sourceRunId: sourceRun.id });
  return yield* requests.take;
});

export const finishFollowupWithAwaitedTask = Effect.fn("finishFollowupWithAwaitedTask")(
  function* () {
    const seeded = yield* seedUnheldFollowup();
    const { orchestrator, sink, childThreadId, taskId } = seeded;
    const now = yield* DateTime.now;
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const followup = child.runs.find((run) => run.delegatedTaskId === taskId);
    if (followup === undefined) return yield* Effect.die("Follow-up run missing");
    const providerThread: OrchestrationV2ProviderThread = {
      id: ProviderThreadId.make("provider-thread:held-followup-child"),
      driver,
      providerInstanceId: modelSelection.instanceId,
      providerSessionId: null,
      appThreadId: childThreadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 2,
      lastRunOrdinal: 2,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      pendingBackgroundTasks: [{ kind: "command", taskId: "followup-command", awaited: true }],
    };
    yield* sink.write({
      commandId: reconcileCommandId("finish-followup-with-await"),
      events: [
        {
          id: EventId.make("event:followup-roster"),
          type: "provider-thread.updated",
          threadId: childThreadId,
          runId: followup.id,
          occurredAt: now,
          payload: providerThread,
        },
        {
          id: EventId.make("event:completed-followup"),
          type: "run.updated",
          threadId: childThreadId,
          runId: followup.id,
          occurredAt: now,
          payload: {
            ...followup,
            status: "completed",
            startedAt: now,
            completedAt: now,
            providerThreadId: providerThread.id,
          },
        },
      ],
    });
    return {
      ...seeded,
      now,
      followup,
      providerThread,
      pending: orchestrator.delegatedTaskResultPending(childThreadId, taskId),
    };
  },
);

export const captureDeliveryQueries = Effect.fn("captureDeliveryQueries")(function* <E, R>(
  effect: Effect.Effect<unknown, E, R>,
) {
  const statements: string[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        end(time, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") statements.push(query);
      };
      return span;
    },
  });
  yield* effect.pipe(Effect.withTracer(tracer));
  return statements;
});

export const followupRosterSettlement = Effect.fn("followupRosterSettlement")(function* () {
  const { sink, orchestrator, providerThread, childThreadId, taskId, threadId, now, followup } =
    yield* finishFollowupWithAwaitedTask();
  const unrelated: OrchestrationV2PendingBackgroundTask = {
    kind: "command",
    taskId: "unrelated",
    awaited: true,
  };
  const legacy: OrchestrationV2PendingBackgroundTask = {
    kind: "command",
    taskId: "legacy",
    awaited: true,
  };
  const base = yield* orchestrator.getThreadProjection(childThreadId);
  const rosterEvent = (
    id: string,
    tasks: OrchestrationV2PendingBackgroundTask[],
    runId?: RunId,
  ) => ({
    id: EventId.make(`event:followup-roster:${id}`),
    type: "provider-thread.updated" as const,
    threadId: childThreadId,
    ...(runId === undefined ? {} : { runId }),
    occurredAt: now,
    payload: { ...providerThread, pendingBackgroundTasks: tasks },
  });
  let replay = applyToProjection(
    { ...base, providerThreads: [] },
    rosterEvent("replay", [...(providerThread.pendingBackgroundTasks ?? [])], followup.id),
  );
  const update = Effect.fn("test.followupRosterUpdate")(function* (
    id: string,
    tasks: OrchestrationV2PendingBackgroundTask[],
    runId?: RunId,
  ) {
    const event = rosterEvent(id, tasks, runId);
    replay = applyToProjection(replay, event);
    yield* sink.write({ events: [event] });
  });
  const original = [...(providerThread.pendingBackgroundTasks ?? [])];
  yield* update("legacy", [...original, legacy]);
  yield* update(
    "unrelated",
    [...original, legacy, unrelated],
    RunId.make("run:unrelated-followup"),
  );
  const { providerThreads } = yield* orchestrator.getThreadProjection(childThreadId);
  const tasks = providerThreads.find(
    (thread) => thread.id === providerThread.id,
  )?.pendingBackgroundTasks;
  const replayTasks = replay.providerThreads.find(
    (thread) => thread.id === providerThread.id,
  )?.pendingBackgroundTasks;
  const ownerFor = (id: string) => tasks?.find((task) => task.taskId === id)?.runId;
  const afterSequence = yield* sink.latestSequence();
  yield* update("owned-task-exit", [legacy, unrelated], RunId.make("run:later-followup"));
  const result = yield* sink
    .stream({ threadId, afterSequence, eventType: "subagent.updated" })
    .pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "subagent.updated" &&
          event.payload.id === taskId &&
          event.payload.result !== null,
      ),
      Stream.map(({ event }) => (event.type === "subagent.updated" ? event.payload.result : null)),
      Stream.runHead,
    );
  return {
    owned: ownerFor("followup-command"),
    otherOwner: ownerFor("unrelated"),
    unattributed: ownerFor("legacy"),
    result: Option.getOrNull(result),
    tasks,
    replayTasks,
  };
});
