import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";

const layerTest = Layer.mergeAll(ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const layerRecoveryTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest()),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});

const createUnfinishedItem = Effect.fn("test.createUnfinishedRecoveryItem")(function* (
  threadId: ThreadId,
  runId: RunId | null,
  type: "command_execution" | "dynamic_tool" | "subagent" = "command_execution",
  status: "pending" | "running" | "waiting" = "running",
  nodeId: NodeId | null = null,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const id = TurnItemId.make(`item:${threadId}:${type}:${status}`);
  const payload: OrchestrationV2TurnItem = {
    id,
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status,
    title: "Unfinished work",
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    ...(type === "subagent"
      ? {
          type,
          subagentId: NodeId.make(`node:${id}`),
          origin: "provider_native" as const,
          driver,
          providerInstanceId,
          childThreadId: null,
          prompt: "Inspect the fixture",
          result: null,
        }
      : type === "dynamic_tool"
        ? { type, toolName: "fixture", input: null }
        : { type, input: "echo fixture" }),
  };
  yield* projections.apply({
    id: EventId.make(`event:${id}`),
    type: "turn-item.updated",
    threadId,
    ...(runId === null ? {} : { runId }),
    occurredAt: now,
    payload,
  });
  return id;
});

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s runtime selection ignores unfinished items on terminal runs", ([, layer]) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const cleanup = new Set<ThreadId>();
    for (const status of [
      "completed",
      "interrupted",
      "failed",
      "cancelled",
      "rolled_back",
    ] as const) {
      for (const type of ["command_execution", "dynamic_tool", "subagent"] as const) {
        for (const itemStatus of ["pending", "running", "waiting"] as const) {
          const threadId = yield* createThread(`${status}:${type}:${itemStatus}`);
          const runId = yield* createRun(threadId, status);
          yield* createUnfinishedItem(threadId, runId, type, itemStatus);
          if (status !== "rolled_back") cleanup.add(threadId);
        }
      }
    }
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    assert.deepEqual(new Set(yield* projections.getRecoveryThreadIds("runtime-cleanup")), cleanup);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s runtime selection retains active and orphaned work", ([, layer]) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const expected = new Set<ThreadId>();
    for (const status of ["preparing", "starting", "running", "waiting", "queued"] as const) {
      const threadId = yield* createThread(`active:${status}`);
      const runId = yield* createRun(threadId, status);
      yield* createUnfinishedItem(threadId, runId);
      expected.add(threadId);
    }
    for (const runId of [null, RunId.make("run:missing")]) {
      const threadId = yield* createThread(`orphan:${runId}`);
      yield* createUnfinishedItem(threadId, runId);
      expected.add(threadId);
    }
    const held = yield* createThread("held-with-stale-item");
    yield* createUnfinishedItem(held, yield* createRun(held, "queued", { queueHeld: true }));
    assert.deepEqual(new Set(yield* projections.getRecoveryThreadIds("runtime")), expected);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime-cleanup")),
      new Set([...expected, held]),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("cleans terminal items without resuming runs, including late item updates", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const cases = [];
    for (const status of ["completed", "interrupted", "failed", "cancelled", "queued"] as const) {
      const threadId = yield* createThread(`cleanup:${status}`);
      const runId = yield* createRun(
        threadId,
        status,
        status === "queued" ? { queueHeld: true } : {},
      );
      const nodeId = NodeId.make(`node:${threadId}`);
      yield* projections.apply({
        id: EventId.make(`event:${nodeId}`),
        type: "node.updated",
        threadId,
        runId,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId,
          runId,
          rootNodeId: nodeId,
          parentNodeId: null,
          kind: "tool_call",
          status: "running",
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      const itemId = yield* createUnfinishedItem(
        threadId,
        runId,
        "command_execution",
        "running",
        nodeId,
      );
      cases.push({ threadId, runId, itemId, nodeId, status });
    }
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    yield* recovery.reconcile("startup");
    for (const { threadId, itemId, nodeId, status } of cases) {
      const projection = yield* projections.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 1);
      assert.equal(projection.runs[0]?.status, status);
      if (status === "queued") assert.isTrue(projection.runs[0]?.queueHeld);
      assert.equal(projection.turnItems.find((item) => item.id === itemId)?.status, "cancelled");
      assert.equal(projection.nodes.find((node) => node.id === nodeId)?.status, "cancelled");
    }
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime-cleanup"), []);
    assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);
    // A provider can deliver an old item update after the run has finished.
    for (const { threadId, runId } of cases) yield* createUnfinishedItem(threadId, runId);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    assert.equal((yield* projections.getRecoveryThreadIds("runtime-cleanup")).length, cases.length);
    // Reconciliation receipts are keyed by boot time; model a later restart.
    yield* TestClock.adjust("1 second");
    yield* recovery.reconcile("startup");
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime-cleanup"), []);
    assert.deepEqual(yield* sql`SELECT effect_id FROM orchestration_v2_effect_outbox`, []);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect.each([
  ["SQL", layerTest],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s keeps active remote tasks live after their parent run finishes", ([, layer]) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("remote-task");
    const runId = yield* createRun(threadId, "completed");
    yield* createUnfinishedItem(threadId, runId, "subagent");
    for (const status of [
      "pending",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
    ] as const) {
      yield* projections.apply({
        id: EventId.make(`event:remote-task:${status}`),
        type: "subagent.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: NodeId.make("node:remote-task"),
          threadId,
          runId,
          parentNodeId: NodeId.make("node:remote-parent"),
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          remote: {
            host: "fixture-host",
            threadId: ThreadId.make("remote-child"),
            correlationId: "remote-fixture",
          },
          nativeTaskRef: null,
          prompt: "Inspect the fixture",
          title: null,
          model: null,
          status,
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      assert.deepEqual(
        yield* projections.getRecoveryThreadIds("runtime"),
        ["pending", "running", "waiting"].includes(status) ? [threadId] : [],
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["startup", "shutdown"] as const)(
  "%s cancels queued buffered wakes and holds durable messages",
  (trigger) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const now = yield* DateTime.now;
      const bufferedThreads = [] as ThreadId[];
      const durableThreads = [] as ThreadId[];
      for (const kind of ["buffered", "user", "notification", "delegated"] as const) {
        const threadId = yield* createThread(`wake:${trigger}:${kind}`);
        const buffered = kind === "buffered";
        (buffered ? bufferedThreads : durableThreads).push(threadId);
        const messageId = MessageId.make(`message:${threadId}`);
        const runId = yield* createRun(threadId, "queued", {
          userMessageId: messageId,
          startedAt: null,
          queuePosition: 1,
        });
        yield* createRun(threadId, "completed", { ordinal: 2 });
        yield* projections.apply({
          id: EventId.make(`message:${threadId}`),
          type: "message.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "Queued work",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: kind === "user" ? "user" : "agent",
            creationSource: buffered ? "provider" : "server",
            ...(kind === "user" || kind === "delegated"
              ? {}
              : {
                  notification: {
                    source: { kind: "background_task" as const },
                    outcome: "updated" as const,
                    summary: "Background activity updated",
                  },
                }),
            ...(kind === "delegated"
              ? { delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [] } }
              : {}),
          },
        });
      }
      assert.deepEqual(
        new Set(yield* projections.getRecoveryThreadIds("runtime")),
        new Set([...bufferedThreads, ...durableThreads]),
      );
      const summary = yield* recovery.reconcile(trigger);
      assert.equal(summary.terminalizedRuns, 1);
      for (const threadId of bufferedThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "cancelled");
        assert.isNotNull(projection.runs[0]?.completedAt);
        assert.isNull(projection.runs[0]?.queuePosition);
        assert.equal(projection.runs[1]?.status, "completed");
      }
      for (const threadId of durableThreads) {
        const projection = yield* projections.getThreadProjection(threadId);
        assert.equal(projection.runs[0]?.status, "queued");
        assert.isTrue(projection.runs[0]?.queueHeld);
      }
      assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
    }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("stops a session its thread detached, which kept its live status", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("detached-session");
    const providerSessionId = ProviderSessionId.make("session:recovery:detached");
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:attached"),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:detached-session:detached"),
      type: "provider-session.detached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: { providerSessionId, detachedAt: now, reason: "Thread settled." },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), [threadId]);

    const summary = yield* recovery.reconcile("startup");

    assert.equal(summary.stoppedSessions, 1);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_provider_sessions
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(rows, [{ status: "stopped" }]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("runtime"), []);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("selects unfinished recovery work without reading settled thread histories", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (let index = 0; index < 600; index += 1) {
      yield* createRun(yield* createThread(`settled-${index}`), "completed");
    }
    const queued = yield* createThread("queued");
    const archived = yield* createThread("archived", { archivedAt: now });
    const deleted = yield* createThread("deleted", { deletedAt: now });
    const blocked = yield* createThread("blocked");
    yield* createRun(queued, "completed");
    for (const threadId of [queued, archived, deleted, blocked]) {
      yield* createRun(threadId, "queued", threadId === queued ? { ordinal: 2 } : {});
    }
    yield* createRun(blocked, "waiting", { ordinal: 2 });
    const background = yield* createThread("background");
    yield* createRun(background, "completed");
    yield* projections.apply({
      id: EventId.make("event:recovery:background"),
      type: "turn-item.updated",
      threadId: background,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:recovery:background"),
        threadId: background,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "dynamic_tool",
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        toolName: "background",
        input: null,
        output: null,
      },
    });
    const outboxOnly = yield* createThread("outbox-only");
    yield* createUnfinishedItem(outboxOnly, yield* createRun(outboxOnly, "completed"));
    yield* outbox.enqueue([
      {
        id: "effect:recovery:outbox-only",
        commandId: CommandId.make("command:recovery:outbox-only"),
        threadId: outboxOnly,
        request: { type: "provider-turn.start", runId: RunId.make("run:outbox-only") },
      },
    ]);
    const requestOnly = yield* createThread("request-only");
    yield* createUnfinishedItem(requestOnly, yield* createRun(requestOnly, "failed"));
    yield* projections.apply({
      id: EventId.make("event:recovery:request-only"),
      type: "runtime-request.updated",
      threadId: requestOnly,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:recovery:pending"),
        nodeId: NodeId.make("node:recovery:request"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Process stopped" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const delivery = yield* createThread("delivery", { archivedAt: now });
    yield* createRun(delivery, "completed", {
      delegatedCompletion: {
        disposition: "open",
        nextGeneration: 2,
        delivery: { generation: 1, messageId: MessageId.make("message:delivery"), taskIds: [] },
      },
    });

    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${ThreadId.make("thread:recovery:settled-599")}
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{broken'
      WHERE thread_id = ${queued} AND ordinal = 1
    `;
    assert.deepEqual(yield* projections.getRecoveryThreadIds("queued-runs"), [queued]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([queued, archived, blocked, background, outboxOnly, requestOnly]),
    );
    assert.deepEqual(yield* projections.getRecoveryThreadIds("delegated-completions"), [delivery]);
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const recoveryState = yield* projections.getRuntimeRecoveryProjection(queued);
    assert.deepEqual(
      recoveryState.runs.map((run) => run.id),
      [RunId.make(`run:${queued}:2`)],
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), [
      queued,
      ThreadId.make("thread:recovery:settled-599"),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recovers terminal subagent results until their cross-thread transfer exists", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const parent = yield* createThread("subagent-parent");
    const children: Array<ThreadId> = [];
    for (const name of ["terminal", "archived", "deleted", "running", "held", "queued"]) {
      const child = yield* createThread(`subagent-${name}`, {
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
        forkedFrom: { type: "node", nodeId: NodeId.make(`node:${name}`) },
        archivedAt: name === "archived" ? now : null,
        deletedAt: name === "deleted" ? now : null,
      });
      yield* createRun(child, name === "running" ? "running" : "completed");
      if (name === "held" || name === "queued") {
        yield* createRun(child, "queued", {
          ordinal: 2,
          startedAt: null,
          ...(name === "held" ? { queueHeld: true } : {}),
        });
      }
      children.push(child);
    }
    const terminalChildren = new Set([children[0]!, children[1]!, children[4]!]);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      terminalChildren,
    );

    const completed = children[0]!;
    const transferId = ContextTransferId.make("transfer:recovery:subagent-result");
    yield* projections.apply({
      id: EventId.make("event:recovery:subagent-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: transferId,
        type: "subagent_result",
        sourceThreadId: completed,
        targetThreadId: parent,
        sourcePoint: { threadId: completed },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    const archivedChild = children[1];
    assert.isDefined(archivedChild);
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("subagent-results")),
      new Set([archivedChild, children[4]!]),
    );
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_context_transfers SET payload_json = '{}'
      WHERE context_transfer_id = ${transferId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([parent, completed]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "memory", layer: ProjectionStore.layerMemory },
])("recovers only recorded follow-up results with $name projections", ({ layer }) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const parent = yield* createThread("followup-parent");
    const child = yield* createThread("followup-child", {
      lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: parent },
      forkedFrom: { type: "node", nodeId: NodeId.make("node:original") },
    });
    const originalRunId = yield* createRun(child, "completed");
    yield* projections.apply({
      id: EventId.make("event:original-result"),
      type: "context-transfer.created",
      threadId: parent,
      occurredAt: now,
      payload: {
        id: ContextTransferId.make("transfer:original-result"),
        type: "subagent_result",
        sourceThreadId: child,
        targetThreadId: parent,
        sourcePoint: { threadId: child, runId: originalRunId },
        basePoint: null,
        sourceProviderInstanceId: providerInstanceId,
        targetProviderInstanceId: providerInstanceId,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
    yield* createRun(child, "completed", { ordinal: 2 });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
    const taskId = NodeId.make("node:followup");
    yield* createRun(child, "completed", { ordinal: 3, delegatedTaskId: taskId });
    yield* createRun(child, "running", { ordinal: 4 });
    const task = {
      id: taskId,
      threadId: parent,
      runId: null,
      parentNodeId: NodeId.make("node:parent"),
      origin: "app_owned" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: child,
      nativeTaskRef: null,
      prompt: "Check the follow-up.",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* projections.apply({
      id: EventId.make("event:followup-task"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: task,
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), [child]);
    yield* projections.apply({
      id: EventId.make("event:followup-settled"),
      type: "subagent.updated",
      threadId: parent,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "Follow-up result.", completedAt: now },
    });
    assert.deepEqual(yield* projections.getRecoveryThreadIds("subagent-results"), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("includes shared sessions and provider-owned background rosters in recovery", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const first = yield* createThread("shared-first");
    const second = yield* createThread("shared-second", { archivedAt: now });
    const providerSessionId = ProviderSessionId.make("session:recovery:shared");
    for (const threadId of [first, second]) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:session`),
        type: "provider-session.attached",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const roster = yield* createThread("roster");
    yield* projections.apply({
      id: EventId.make("event:recovery:roster"),
      type: "provider-thread.updated",
      threadId: roster,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make("provider-thread:recovery:roster"),
        appThreadId: roster,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "background", description: "Still running", kind: "command" },
        ],
      },
    });
    const prepared = yield* createThread("prepared-continuation");
    const preparedSessionId = ProviderSessionId.make("session:recovery:prepared");
    const preparedProviderThreadId = ProviderThreadId.make("provider-thread:recovery:prepared");
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-session"),
      type: "provider-session.attached",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedSessionId,
        driver,
        providerInstanceId,
        status: "stopped",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("event:recovery:prepared-thread"),
      type: "provider-thread.updated",
      threadId: prepared,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: preparedProviderThreadId,
        appThreadId: prepared,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId: preparedSessionId,
        nativeThreadRef: { driver, nativeId: "native:prepared", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [],
      },
    });
    const preparedRunId = yield* createRun(prepared, "starting", {
      providerThreadId: preparedProviderThreadId,
      restartContinuationOfRunId: RunId.make("run:recovery:source"),
    });
    assert.deepEqual(
      new Set(yield* projections.getRecoveryThreadIds("runtime")),
      new Set([first, second, roster, prepared]),
    );
    const preparedState = yield* projections.getRuntimeRecoveryProjection(prepared);
    assert.deepEqual(
      preparedState.providerSessions.map((session) => session.id),
      [preparedSessionId],
    );
    assert.equal(restartContinuationRun(preparedState, yield* DateTime.now)?.id, preparedRunId);
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE orchestration_v2_projection_provider_sessions SET payload_json = '{}'
      WHERE provider_session_id = ${providerSessionId}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([first, second]),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reads the run that owns a background roster, not a queued or resumed one", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const withRoster = Effect.fn(function* (threadId: ThreadId) {
      yield* projections.apply({
        id: EventId.make(`event:${threadId}:roster`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ProviderThreadId.make(`provider-thread:${threadId}`),
          appThreadId: threadId,
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          pendingBackgroundTasks: [
            { taskId: "background", description: "Still running", kind: "command" },
          ],
        },
      });
    });
    const runIds = (threadId: ThreadId) =>
      projections
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.map((state) => state.runs.map((run) => run.id)));
    const settled = yield* createThread("roster-before-queue");
    const settledRun = yield* createRun(settled, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${settled}`),
    });
    const queuedRun = yield* createRun(settled, "queued", { ordinal: 2, completedAt: null });
    yield* withRoster(settled);
    assert.deepEqual(yield* runIds(settled), [settledRun, queuedRun]);
    const resumed = yield* createThread("roster-after-resume");
    const resumedRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z"),
    });
    const continuationRun = yield* createRun(resumed, "completed", {
      providerThreadId: ProviderThreadId.make(`provider-thread:${resumed}`),
      ordinal: 2,
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    });
    yield* withRoster(resumed);
    assert.deepEqual(yield* runIds(resumed), [resumedRun, continuationRun]);
    const quiet = yield* createThread("no-roster-before-queue");
    yield* createRun(quiet, "completed");
    const quietQueued = yield* createRun(quiet, "queued", { ordinal: 2, completedAt: null });
    assert.deepEqual(yield* runIds(quiet), [quietQueued]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes the run whose subagent lost its shell, past a wake cut before it started", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("subagent-shell");
    const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:session`),
      type: "provider-session.attached",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "ready",
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    const settledRun = yield* createRun(threadId, "completed", { providerThreadId });
    yield* createRun(threadId, "starting", {
      ordinal: 2,
      providerThreadId,
      startedAt: null,
      completedAt: null,
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:roster`),
      type: "provider-thread.updated",
      threadId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId,
        providerSessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 2,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        pendingBackgroundTasks: [
          { taskId: "shell", description: "sleep 150", kind: "command", parentTaskId: "agent" },
        ],
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      { kind: "subagent", label: "sleep 150 (subagent agent)", id: "agent" },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("wakes a settled run whose native subagent ran on its own provider thread", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = yield* createThread("native-subagent");
    const parentProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
    const childProviderThreadId = ProviderThreadId.make(`provider-thread:${threadId}:child`);
    const providerSessionId = ProviderSessionId.make(`session:${threadId}`);
    const subagentId = NodeId.make(`node:${threadId}:subagent`);
    // An older thread on the same Codex session is recovered first and stops it.
    const sibling = yield* createThread("a-shared-session");
    yield* createRun(sibling, "completed");
    for (const boundThreadId of [sibling, threadId]) {
      yield* projections.apply({
        id: EventId.make(`event:${boundThreadId}:session`),
        type: "provider-session.attached",
        threadId: boundThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver,
          providerInstanceId,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
    }
    const settledRun = yield* createRun(threadId, "completed", {
      providerThreadId: parentProviderThreadId,
    });
    for (const [id, nativeId] of [
      [parentProviderThreadId, "native-thread"],
      [childProviderThreadId, "agent-thread"],
    ] as const) {
      yield* projections.apply({
        id: EventId.make(`event:${id}`),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id,
          appThreadId:
            id === parentProviderThreadId ? threadId : ThreadId.make(`${threadId}:child`),
          ownerNodeId: null,
          driver,
          providerInstanceId,
          providerSessionId,
          nativeThreadRef: { driver, nativeId, strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: id === parentProviderThreadId ? 1 : null,
          lastRunOrdinal: id === parentProviderThreadId ? 1 : null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    const subagent = {
      threadId,
      runId: settledRun,
      origin: "provider_native",
      driver,
      providerInstanceId,
      childThreadId: null,
      prompt: "audit src",
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    } as const;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent`),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: subagentId,
        parentNodeId: NodeId.make(`node:${threadId}:root`),
        createdBy: "agent",
        providerThreadId: childProviderThreadId,
        nativeTaskRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        title: null,
        model: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:subagent-item`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...subagent,
        id: TurnItemId.make(`item:${threadId}:subagent`),
        nodeId: subagentId,
        providerThreadId: childProviderThreadId,
        providerTurnId: null,
        nativeItemRef: { driver, nativeId: "call_1:agent-thread", strength: "strong" },
        parentItemId: null,
        ordinal: 1,
        type: "subagent",
        title: "audit",
        subagentId,
      },
    });

    yield* recovery.reconcile("startup");

    const effects = yield* sql<{ readonly effect_id: string }>`
      SELECT effect_id FROM orchestration_v2_effect_outbox WHERE thread_id = ${threadId}
    `;
    assert.deepEqual(effects, [{ effect_id: `effect:restart-continuation:${settledRun}` }]);
    const projection = yield* projections.getThreadProjection(threadId);
    assert.deepEqual(projection.runs[0]?.restartCancelledBackgroundWork, [
      {
        kind: "subagent",
        label: "audit (id agent-thread)",
        id: TurnItemId.make(`item:${threadId}:subagent`),
      },
    ]);
  }).pipe(Effect.provide(layerRecoveryTest)),
);

it.effect("marks fork descendants unreadable when their source is missing or corrupt", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const source = yield* createThread("source");
    const sourceRun = yield* createRun(source, "completed");
    const fork = yield* createThread("fork", {
      forkedFrom: { type: "run", threadId: source, runId: sourceRun },
    });
    const descendant = yield* createThread("descendant", {
      forkedFrom: { type: "run", threadId: fork, runId: RunId.make("run:fork") },
    });
    assert.deepEqual(yield* projections.getUnreadableThreadIds(), []);
    yield* sql`
      UPDATE orchestration_v2_projection_runs SET payload_json = '{}'
      WHERE run_id = ${sourceRun}
    `;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([source, fork, descendant]),
    );
    yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = ${source}`;
    assert.deepEqual(
      new Set(yield* projections.getUnreadableThreadIds()),
      new Set([fork, descendant]),
    );
  }).pipe(Effect.provide(layerTest)),
);
