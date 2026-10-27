import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@goat/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
export const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};

export const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  beforeCompaction: Effect.Effect<void> = Effect.void,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: canRestart,
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: Effect.fn("SteeringHarness.openSession")(function* (input) {
      const now = yield* DateTime.now;
      const startTurn = Effect.fn("SteeringHarness.startTurn")(function* (
        turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      ) {
        started.push(turn);
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: {
            id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
            providerThreadId: turn.providerThread.id,
            nodeId: turn.rootNodeId,
            runAttemptId: turn.attemptId,
            nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
            ordinal: turn.providerTurnOrdinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        });
      });
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
          model: runSelection.model,
          capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: ({ threadId }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider-thread:${threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: threadId,
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
        startTurn,
        compactThread: (turn) => beforeCompaction.pipe(Effect.andThen(startTurn(turn))),
        steerTurn: (turn) =>
          Effect.sync(() => {
            steered.push(turn.message.text);
          }),
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerSingle(adapter),
    { runEffectWorker: false },
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    return threadId;
  });
  return { cwd, events, started, steered, layer, startFirstTurn };
});

export const goalHarness = Effect.fn("goalHarness")(function* (
  name: string,
  beforeCompaction: Effect.Effect<void> = Effect.void,
) {
  const harness = yield* nextTurnSelectionHarness(name, false, beforeCompaction);
  const send = Effect.fn("SteeringHarness.sendGoalMessage")(function* (
    id: string,
    text: string,
    delivery: "queue" | "auto",
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId: ThreadId.make(`thread:${name}`),
      messageId: MessageId.make(`message:${id}`),
      text,
      attachments: [],
      modelSelection: runSelection,
      ...(delivery === "queue"
        ? { dispatchMode: { type: "queue_after_active" } }
        : { dispatchMode: { type: "start_immediately" }, deliveryIntent: "auto" }),
      createdBy: "user",
      creationSource: "web",
    });
  });
  const read = Effect.fn("SteeringHarness.readGoalThread")(function* (threadId: ThreadId) {
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
    const textOf = (run: (typeof projection.runs)[number]) =>
      projection.messages.find((message) => message.id === run.userMessageId)?.text;
    return {
      queue: projection.runs
        .filter((run) => run.status === "queued")
        .toSorted((left, right) => (left.queuePosition ?? 0) - (right.queuePosition ?? 0))
        .map(textOf),
      started: harness.started.map((turn) => turn.message.text),
      stopRequested: projection.turnItems.some(
        (item) => item.type === "run_interrupt_request" && item.runId === harness.started[0]?.runId,
      ),
    };
  });
  return { ...harness, send, read };
});
