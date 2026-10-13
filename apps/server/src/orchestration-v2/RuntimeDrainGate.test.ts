import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  RuntimeAdmission.layer,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "drain-gate" },
    ProviderAdapterRegistry.layerFromAdapters([]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const threadId = ThreadId.make("drain-thread");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const message = (
  key: string,
): Extract<OrchestrationV2ServerCommand, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(key),
  threadId,
  messageId: MessageId.make(key),
  text: "hello",
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
});
const create = {
  type: "thread.create",
  commandId: CommandId.make("create"),
  threadId,
  projectId: ProjectId.make("drain-project"),
  title: "Before",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
} satisfies OrchestrationV2ServerCommand;

it.effect("public dispatch gates all new-work sources while metadata and stop controls pass", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const gate = yield* RuntimeAdmission.RuntimeAdmission;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* gate.beginDrain;
    yield* orchestrator.dispatch(create); // thread.create carries no first message in this schema.
    for (const creationSource of ["web", "mobile", "mcp", "server", "provider"] as const) {
      for (const dispatchMode of [
        { type: "start_immediately" },
        { type: "defer_start" },
        { type: "queue_after_active" },
      ] as const) {
        const failure = yield* orchestrator
          .dispatch({
            ...message(`${creationSource}:${dispatchMode.type}`),
            creationSource,
            dispatchMode,
          })
          .pipe(Effect.flip);
        assert.equal(failure._tag, "ServerDrainingError");
        assert.equal(
          userFacingDispatchErrorMessage(failure),
          "The server is restarting for an update. Retry after it reconnects.",
        );
        assert.equal(
          failure.message,
          "The server is restarting for an update. Retry after it reconnects.",
        );
      }
    }
    for (const dispatchMode of [
      { type: "steer_active", targetRunId: RunId.make("already-done") },
      { type: "restart_active", targetRunId: RunId.make("already-done") },
    ] as const) {
      const failure = yield* orchestrator
        .dispatch({ ...message(dispatchMode.type), dispatchMode })
        .pipe(Effect.flip);
      assert.equal(failure._tag, "ServerDrainingError");
    }
    const delegated = yield* orchestrator
      .dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate"),
        parentThreadId: threadId,
        parentRunId: RunId.make("parent-run"),
        parentNodeId: NodeId.make("parent-node"),
        task: "New child work",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);
    assert.equal(delegated._tag, "ServerDrainingError");
    const retry = yield* orchestrator
      .dispatch({
        type: "prepared-run.retry",
        commandId: CommandId.make("retry"),
        threadId,
        runId: RunId.make("failed-preparation"),
      })
      .pipe(Effect.flip);
    assert.equal(retry._tag, "ServerDrainingError");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename"),
      threadId,
      title: "After",
    });
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop"),
      threadId,
    });
    assert.equal((yield* projections.getThread(threadId)).title, "After");
    assert.equal((yield* projections.getThreadRecords(threadId, ["runs"])).runs.length, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "restart, usage-limit, delegated deliveries and notifications reach dispatch policy",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch(create);
      yield* (yield* RuntimeAdmission.RuntimeAdmission).beginDrain;
      const continuation = RunId.make("prior-run");
      const commands = [
        { ...message("restart"), restartContinuationOfRunId: continuation },
        { ...message("usage-limit"), usageLimitContinuationOfRunId: continuation },
        {
          ...message("delegated"),
          delegatedCompletion: {
            parentRunId: continuation,
            generation: 1,
            taskIds: [NodeId.make("task")],
          },
        },
        {
          ...message("notification"),
          notification: {
            source: { kind: "system" as const },
            outcome: "completed" as const,
            summary: "Existing work finished",
          },
        },
      ];
      for (const command of commands) {
        const result = yield* orchestrator.dispatch(command).pipe(Effect.result);
        // The fixtures have no provider or interrupted run: downstream policy rejects them,
        // demonstrating that drain admission allowed the continuation to reach that policy.
        if (result._tag === "Failure") assert.notEqual(result.failure._tag, "ServerDrainingError");
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect("steering into a live run passes admission; a completed target requires admission", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch(create);
    const now = yield* DateTime.now;
    const runId = RunId.make("existing-run");
    const run = {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("existing-message"),
      rootNodeId: null,
      activeAttemptId: null,
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* projections.apply({
      id: EventId.make("running"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "running" },
    });
    yield* (yield* RuntimeAdmission.RuntimeAdmission).beginDrain;
    for (const type of ["steer_active", "restart_active"] as const) {
      const result = yield* orchestrator
        .dispatch({ ...message(`live:${type}`), dispatchMode: { type, targetRunId: runId } })
        .pipe(Effect.result);
      if (result._tag === "Failure") assert.notEqual(result.failure._tag, "ServerDrainingError");
    }
    yield* projections.apply({
      id: EventId.make("completed"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    const failure = yield* orchestrator
      .dispatch({
        ...message("late-steer"),
        dispatchMode: { type: "steer_active", targetRunId: runId },
      })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "ServerDrainingError");
  }).pipe(Effect.provide(layerTest)),
);
