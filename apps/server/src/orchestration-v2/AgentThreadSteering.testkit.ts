/** The steering harness: a target thread with a controllable turn, for message delivery tests. */
import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaDriver from "../cua/CuaDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

export const driver = ProviderDriverKind.make("codex");
export const instanceId = ProviderInstanceId.make("codex");
export const modelSelection: ModelSelection = { instanceId, model: "test-model" };
export const projectId = ProjectId.make("project:agent-thread-steering");
export const threadId = ThreadId.make("thread:agent-thread-steering:target");
export const senderThreadId = ThreadId.make("thread:agent-thread-steering:sender");
export const agentMessageId = MessageId.make("message:from-sender");

export type Turn = ProviderAdapter.ProviderAdapterV2TurnInput;
export type Events = Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;

export const harness = Effect.fn("agentThreadSteeringHarness")(function* (
  name: string,
  turns: {
    readonly supportsActiveSteering: boolean;
    readonly restartSteering?: boolean;
    /** Computer use is on, so unattended messages may not join a person's turn. */
    readonly computerUse?: boolean;
  },
) {
  const cwd = yield* checkpointWorkspace("agent-thread-steering-" + name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: Turn[] = [];
  const steered: ProviderAdapter.ProviderAdapterV2SteerInput[] = [];
  const interrupted: ProviderAdapter.ProviderAdapterV2InterruptInput[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: turns.supportsActiveSteering,
      supportsSteeringByInterruptRestart: turns.restartSteering ?? false,
      supportsQueuedMessages: true,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId: appThreadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make("provider-thread:" + appThreadId),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          // The turn is accepted but reports running only when the test says so.
          startTurn: (turn) => Effect.sync(() => void started.push(turn)),
          steerTurn: (turn) => Effect.sync(() => void steered.push(turn)),
          interruptTurn: (turn) =>
            Effect.gen(function* () {
              interrupted.push(turn);
              const accepted = started.find(
                (candidate) =>
                  ProviderTurnId.make("provider-turn:" + candidate.attemptId) ===
                  turn.providerTurnId,
              );
              if (accepted === undefined)
                return yield* Effect.die("Interrupt has no accepted turn");
              const now = yield* DateTime.now;
              const providerTurn = {
                ...providerTurnFor(accepted, now),
                status: "interrupted" as const,
                completedAt: now,
              };
              yield* Queue.offerAll(events, [
                { type: "provider_turn.updated", driver, providerTurn },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: providerTurn.providerThreadId,
                  providerTurnId: providerTurn.id,
                  runOrdinal: accepted.runOrdinal,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const layerDatabase = SqlitePersistence.layerMemory;
  const layer = ThreadManagementService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
        ServerSettings.layerTest(),
        ...(turns.computerUse === true
          ? [
              Layer.mock(CuaDriver.CuaDriver)({
                enabled: Effect.succeed(true),
                acquire: Effect.succeedNone,
              }),
            ]
          : []),
        ProviderReplayHarness.layerWithRegistry(
          { name: "agent-thread-steering-" + name },
          ProviderAdapterRegistry.layerSingle(adapter),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
    ),
  );
  return { cwd, events, started, steered, interrupted, layer };
});

export const awaitDomainEvent = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
  });

export const providerTurnFor = (turn: Turn, now: DateTime.Utc) => ({
  id: ProviderTurnId.make("provider-turn:" + turn.attemptId),
  providerThreadId: turn.providerThread.id,
  nodeId: turn.rootNodeId,
  runAttemptId: turn.attemptId,
  nativeTurnRef: { driver, nativeId: "native:" + turn.attemptId, strength: "strong" as const },
  ordinal: turn.providerTurnOrdinal,
  status: "running" as const,
  startedAt: now,
  completedAt: null,
});

export const reportRunning = (events: Events, turn: Turn) =>
  Effect.gen(function* () {
    const running = yield* awaitDomainEvent(
      (event) =>
        event.type === "provider-turn.updated" &&
        event.payload.runAttemptId === turn.attemptId &&
        event.payload.status === "running",
    );
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: providerTurnFor(turn, yield* DateTime.now),
    });
    yield* Fiber.join(running);
  });

export const reportCompleted = (events: Events, turn: Turn) =>
  Effect.gen(function* () {
    const settled = yield* awaitDomainEvent(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === turn.runId &&
        event.payload.status === "waiting",
    );
    const now = yield* DateTime.now;
    const providerTurn = {
      ...providerTurnFor(turn, now),
      status: "completed" as const,
      completedAt: now,
    };
    yield* Queue.offer(events, { type: "provider_turn.updated", driver, providerTurn });
    yield* Queue.offer(events, {
      type: "turn.terminal",
      driver,
      providerThreadId: providerTurn.providerThreadId,
      providerTurnId: providerTurn.id,
      runOrdinal: turn.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    yield* Fiber.join(settled);
  });

/** Creates the target thread and, unless it stays idle, starts a turn that is still starting. */
export const startTarget = (cwd: string, started: ReadonlyArray<Turn>, idle = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId,
      title: "Target",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    if (idle) return;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "long task",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    assert.equal(started.length, 1);
  });

export const send = (
  mode: ThreadManagementService.ThreadManagementSendMode = "steer_when_ready",
  text = "update from the sender thread",
  sender: ThreadId = senderThreadId,
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* threads.sendToThread({
      projectId,
      commandId: CommandId.make("agent-send"),
      threadId,
      senderThreadId: sender,
      messageId: agentMessageId,
      text,
      attachments: [],
      mode,
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

export const agentMessageRunId = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  return projection.messages.find((message) => message.id === agentMessageId)?.runId;
});

/** A question in the target thread that its asker resumes by message, as Codex async ones do. */
export const askByMessage = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const requestId = RuntimeRequestId.make("request:by-message");
  const nodeId = NodeId.make("node:by-message");
  const shared = { threadId, providerThreadId: null, providerTurnId: null, nativeItemRef: null };
  yield* eventSink.write({
    commandId: CommandId.make("ask-by-message"),
    events: [
      {
        id: EventId.make("ask-by-message-node"),
        type: "node.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          ...shared,
          id: nodeId,
          runId: null,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      },
      {
        id: EventId.make("ask-by-message-request"),
        type: "runtime-request.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      },
      {
        id: EventId.make("ask-by-message-item"),
        type: "turn-item.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          ...shared,
          id: TurnItemId.make("item:by-message"),
          type: "user_input_request",
          runId: null,
          nodeId,
          parentItemId: null,
          ordinal: 0,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          requestId,
          responseMode: "message",
          questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
        },
      },
    ],
  });
  return requestId;
});
