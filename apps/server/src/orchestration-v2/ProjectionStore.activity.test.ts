import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "./ProjectionStore.ts";

import {
  layerTest,
  driver,
  providerInstanceId,
  traceSqlStatements,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore.testkit.ts";

it.effect("reads server activity using a bounded projection query", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    for (const status of [
      "preparing",
      "starting",
      "running",
      "waiting",
      "queued",
      "completed",
      "failed",
      "interrupted",
    ]) {
      yield* sql`DELETE FROM orchestration_v2_projection_runs`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('activity-run', 'activity-thread', 1, 'codex', ${status}, '2026-10-11T00:00:00Z', '{}')`;
      assert.strictEqual(
        yield* store.getServerActivity(),
        ["preparing", "starting", "running", "waiting", "queued"].includes(status)
          ? "busy"
          : "idle",
      );
    }
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'queued', payload_json = '{"queueHeld":true}'`;
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{"queueHeld":false}'`;
    assert.strictEqual(yield* store.getServerActivity(), "busy");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "replay", layer: ProjectionStore.layerMemory },
])("$name keeps post-root background work busy until it finishes", ({ layer }) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("activity-background");
    const now = yield* DateTime.now;
    const projection = yield* store.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    const item = projection.turnItems[0]!;
    if (item.type !== "command_execution" || run.rootNodeId === null)
      throw new Error("Invalid root fixture");
    const rootNodeId = run.rootNodeId;
    yield* store.apply({
      id: EventId.make("activity:item-ended"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: { ...item, status: "completed", completedAt: now },
    });
    yield* store.apply({
      id: EventId.make("activity:root-ended"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "completed", completedAt: now },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    const nodeId = NodeId.make("activity:native-child");
    const node = {
      id: nodeId,
      threadId,
      runId: null,
      parentNodeId: rootNodeId,
      rootNodeId: rootNodeId,
      kind: "subagent" as const,
      status: "running" as const,
      countsForRun: false,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    yield* store.apply({
      id: EventId.make("activity:child-started"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: node,
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* store.apply({
      id: EventId.make("activity:child-ended"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: { ...node, status: "completed", completedAt: now },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    const task = {
      id: nodeId,
      threadId,
      runId: run.id,
      parentNodeId: rootNodeId,
      origin: "provider_native" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Background work",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* store.apply({
      id: EventId.make("activity:task-started"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: task,
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* store.apply({
      id: EventId.make("activity:task-ended"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: { ...task, status: "completed", completedAt: now },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    for (const type of ["command_execution", "dynamic_tool", "subagent"] as const) {
      const base = {
        ...item,
        id: TurnItemId.make(`activity:${type}`),
        runId: null,
        status: "running" as const,
      };
      const work =
        type === "command_execution"
          ? { ...base, type, input: "background work" }
          : type === "dynamic_tool"
            ? { ...base, type, input: "background work", toolName: "tool" }
            : {
                ...base,
                type,
                prompt: "background work",
                childThreadId: null,
                subagentId: nodeId,
                origin: "provider_native" as const,
                driver,
                providerInstanceId,
                result: null,
              };
      yield* store.apply({
        id: EventId.make(`activity:${type}:started`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: work,
      });
      assert.strictEqual(yield* store.getServerActivity(), "busy");
      yield* store.apply({
        id: EventId.make(`activity:${type}:ended`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: { ...work, status: "completed", completedAt: now },
      });
      assert.strictEqual(yield* store.getServerActivity(), "idle");
    }
    const providerTurn = {
      id: ProviderTurnId.make("activity:provider-turn"),
      providerThreadId: ProviderThreadId.make("activity:provider"),
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running" as const,
      startedAt: now,
      completedAt: null,
    };
    yield* store.apply({
      id: EventId.make("activity:provider-turn-started"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: providerTurn,
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* store.apply({
      id: EventId.make("activity:provider-turn-ended"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: { ...providerTurn, status: "completed", completedAt: now },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    const request = {
      id: RuntimeRequestId.make("activity:input"),
      nodeId,
      providerTurnId: providerTurn.id,
      nativeRequestRef: null,
      kind: "user_input" as const,
      status: "pending" as const,
      responseCapability: { type: "message" as const },
      createdAt: now,
      resolvedAt: null,
    };
    yield* store.apply({
      id: EventId.make("activity:input-pending"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: request,
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* store.apply({
      id: EventId.make("activity:input-resolved"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: { ...request, status: "resolved", resolvedAt: now },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    const providerThread = {
      id: ProviderThreadId.make("activity:provider"),
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle" as const,
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      pendingBackgroundTasks: [{ taskId: "native-background", kind: "subagent" as const }],
    };
    yield* store.apply({
      id: EventId.make("activity:roster-started"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: providerThread,
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* store.apply({
      id: EventId.make("activity:roster-ended"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: { ...providerThread, pendingBackgroundTasks: [] },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "replay", layer: ProjectionStore.layerMemory },
])(
  "$name ignores pending work owned by a held queue but counts runnable and started work",
  ({ layer }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("activity-held");
      const now = yield* DateTime.now;
      const projection = yield* store.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const item = projection.turnItems[0]!;
      if (run.rootNodeId === null) throw new Error("Root node missing");
      const rootNodeId = run.rootNodeId;
      const heldRun = {
        ...run,
        status: "queued" as const,
        queueHeld: true,
        startedAt: null,
        completedAt: null,
      };
      yield* store.apply({
        id: EventId.make("held:run"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: heldRun,
      });
      yield* store.apply({
        id: EventId.make("held:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: { ...item, status: "pending", startedAt: null, completedAt: null },
      });
      const node = {
        id: rootNodeId,
        threadId,
        runId: run.id,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn" as const,
        status: "pending" as const,
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: null,
        completedAt: null,
      };
      yield* store.apply({
        id: EventId.make("held:node"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: node,
      });
      const turn = {
        id: ProviderTurnId.make("held:turn"),
        providerThreadId: ProviderThreadId.make("held:provider"),
        nodeId: rootNodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "pending" as const,
        startedAt: null,
        completedAt: null,
      };
      yield* store.apply({
        id: EventId.make("held:turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: turn,
      });
      const task = {
        id: NodeId.make("held:task"),
        threadId,
        runId: run.id,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Queued delegation",
        title: null,
        model: null,
        status: "pending" as const,
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("held:task"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: task,
      });
      assert.strictEqual(yield* store.getServerActivity(), "idle");
      yield* store.apply({
        id: EventId.make("held:runnable"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...heldRun, queueHeld: false },
      });
      assert.strictEqual(yield* store.getServerActivity(), "busy");
      yield* store.apply({
        id: EventId.make("held:held-again"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: heldRun,
      });
      assert.strictEqual(yield* store.getServerActivity(), "idle");
      yield* store.apply({
        id: EventId.make("held:pending-but-started"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: { ...node, startedAt: now },
      });
      assert.strictEqual(yield* store.getServerActivity(), "busy");
      yield* store.apply({
        id: EventId.make("held:already-running"),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: { ...node, status: "running", startedAt: now },
      });
      assert.strictEqual(yield* store.getServerActivity(), "busy");
    }).pipe(Effect.provide(layer)),
);

/** A thread whose only turn completed, as every leftover in the stuck-update reports had. */
const addFinishedTurn = Effect.fn("addFinishedTurn")(function* (suffix: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate(suffix);
  const now = yield* DateTime.now;
  const projection = yield* store.getThreadProjection(threadId);
  const run = projection.runs[0]!;
  const item = projection.turnItems[0]!;
  if (run.rootNodeId === null) throw new Error("Root node missing");
  yield* store.apply({
    id: EventId.make(`${suffix}:item-ended`),
    type: "turn-item.updated",
    threadId,
    occurredAt: now,
    payload: { ...item, status: "completed", completedAt: now },
  });
  yield* store.apply({
    id: EventId.make(`${suffix}:run-ended`),
    type: "run.updated",
    threadId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  return { threadId, run, rootNodeId: run.rootNodeId, now };
});

const openNode = (input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly rootNodeId: NodeId;
  readonly kind: "todo_list" | "tool_call" | "user_input_request" | "subagent";
  readonly status: "running" | "waiting";
  readonly startedAt: DateTime.Utc;
}) => ({
  id: NodeId.make(input.id),
  threadId: input.threadId,
  runId: input.runId,
  parentNodeId: input.rootNodeId,
  rootNodeId: input.rootNodeId,
  kind: input.kind,
  status: input.status,
  countsForRun: false,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  runtimeRequestId: null,
  checkpointScopeId: null,
  startedAt: input.startedAt,
  completedAt: null,
});

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "replay", layer: ProjectionStore.layerMemory },
])("$name lets nothing a finished turn left open hold runtime updates", ({ layer }) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const live = yield* addRolledBackRecoveryCandidate("activity-live");
    const rolledBack = (yield* store.getThreadProjection(live)).runs[0]!;
    const liveRun = { ...rolledBack, status: "running" as const, completedAt: null };
    yield* store.apply({
      id: EventId.make("activity-live:running"),
      type: "run.updated",
      threadId: live,
      occurredAt: rolledBack.startedAt!,
      payload: liveRun,
    });
    assert.deepStrictEqual(yield* store.getServerActivityBlockers(5), [
      {
        threadId: live,
        title: "Rolled-back recovery candidate",
        reason: "running",
        since: DateTime.formatIso(liveRun.startedAt!),
      },
    ]);
    yield* store.apply({
      id: EventId.make("activity-live:interrupted"),
      type: "run.updated",
      threadId: live,
      occurredAt: liveRun.startedAt!,
      payload: { ...liveRun, status: "interrupted", completedAt: liveRun.startedAt },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");

    const { threadId, run, rootNodeId, now } = yield* addFinishedTurn("activity-leftovers");
    // Codex turn-plan and exec items, a question the turn outlived, and a node whose run is gone.
    for (const node of [
      { id: "leftover:plan", runId: run.id, kind: "todo_list", status: "running" },
      { id: "leftover:exec", runId: run.id, kind: "tool_call", status: "running" },
      { id: "leftover:question", runId: run.id, kind: "user_input_request", status: "waiting" },
      {
        id: "leftover:orphan",
        runId: RunId.make("run:missing"),
        kind: "subagent",
        status: "running",
      },
    ] as const) {
      yield* store.apply({
        id: EventId.make(`${node.id}:open`),
        type: "node.updated",
        threadId,
        occurredAt: now,
        payload: openNode({ ...node, threadId, rootNodeId, startedAt: now }),
      });
    }
    yield* store.apply({
      id: EventId.make("leftover:provider-turn"),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make("leftover:provider-turn"),
        providerThreadId: ProviderThreadId.make("leftover:provider"),
        nodeId: rootNodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    yield* store.apply({
      id: EventId.make("leftover:request"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("leftover:request"),
        nodeId: rootNodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
    assert.deepStrictEqual(yield* store.getServerActivityBlockers(5), []);
    if (layer === layerTest) {
      const ignored = yield* store.getIgnoredActivity(5);
      assert.deepStrictEqual(ignored.find((entry) => entry.threadId === threadId)?.openRecords, 4);
    }

    // A native child that outlived its completed turn is real work, until that turn is interrupted.
    const task = {
      id: NodeId.make("leftover:task"),
      threadId,
      runId: run.id,
      parentNodeId: rootNodeId,
      origin: "provider_native" as const,
      createdBy: "agent" as const,
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Background work",
      title: null,
      model: null,
      status: "running" as const,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    yield* store.apply({
      id: EventId.make("leftover:task"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: task,
    });
    assert.deepStrictEqual(
      (yield* store.getServerActivityBlockers(5)).map((blocker) => [
        blocker.threadId,
        blocker.reason,
      ]),
      [[threadId, "background"]],
    );
    yield* store.apply({
      id: EventId.make("leftover:run-interrupted"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...run, status: "interrupted", completedAt: now },
    });
    assert.strictEqual(yield* store.getServerActivity(), "idle");
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  { name: "SQLite", layer: layerTest },
  { name: "replay", layer: ProjectionStore.layerMemory },
])("$name stops counting background work with no sign of life past the stale bound", ({ layer }) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, rootNodeId, now } = yield* addFinishedTurn("activity-stale");
    yield* store.apply({
      id: EventId.make("activity-stale:child"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: openNode({
        id: "activity-stale:child",
        threadId,
        runId: null,
        rootNodeId,
        kind: "subagent",
        status: "running",
        startedAt: now,
      }),
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* TestClock.adjust(ProjectionStore.STALE_BACKGROUND_WORK_MS);
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* TestClock.adjust(1);
    assert.strictEqual(yield* store.getServerActivity(), "idle");
  }).pipe(Effect.provide(layer)),
);

it.effect("SQLite drops background work recorded before the server started", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, rootNodeId, now } = yield* addFinishedTurn("activity-restart");
    yield* store.apply({
      id: EventId.make("activity-restart:child"),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: openNode({
        id: "activity-restart:child",
        threadId,
        runId: null,
        rootNodeId,
        kind: "subagent",
        status: "running",
        startedAt: now,
      }),
    });
    assert.strictEqual(yield* store.getServerActivity(), "busy");
    yield* TestClock.adjust(1);
    // The provider process that ran it exited with the previous server.
    const restarted = Context.get(
      yield* Layer.build(Layer.fresh(ProjectionStore.layer)),
      ProjectionStore.ProjectionStoreV2,
    );
    assert.deepStrictEqual(yield* restarted.getServerActivityBlockers(5), []);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("uses indexed activity predicates on populated projections", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const tables = [
      [
        "runs",
        "run_id,thread_id,ordinal,provider,status,requested_at,payload_json",
        "'run:'||n,'history:'||n,1,'codex','completed','2026-10-11','{}'",
      ],
      [
        "nodes",
        "node_id,thread_id,root_node_id,kind,status,payload_json",
        "'node:'||n,'history:'||n,'node:'||n,'root_turn','completed','{}'",
      ],
      [
        "subagents",
        "subagent_id,thread_id,parent_node_id,provider,origin,status,updated_at,payload_json",
        "'task:'||n,'history:'||n,'node:'||n,'codex','provider_native','completed','2026-10-11','{}'",
      ],
      [
        "turn_items",
        "turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json",
        "'item:'||n,'history:'||n,1,'command_execution','completed','2026-10-11','{}'",
      ],
      [
        "provider_turns",
        "provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,payload_json",
        "'turn:'||n,'history:'||n,'provider:'||n,'node:'||n,1,'completed','{}'",
      ],
      [
        "provider_threads",
        "provider_thread_id,provider,status,updated_at,payload_json",
        "'provider:'||n,'codex','idle','2026-10-11','{}'",
      ],
      [
        "runtime_requests",
        "runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json",
        "'request:'||n,'history:'||n,'node:'||n,'user_input','resolved','2026-10-11','{}'",
      ],
    ];
    for (const [table, columns, values] of tables) {
      yield* sql.unsafe(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n < 1000)
      INSERT INTO orchestration_v2_projection_${table} (${columns}) SELECT ${values} FROM history`);
    }
    yield* sql`ANALYZE`;
    const { statements, tracer } = traceSqlStatements();
    assert.strictEqual(yield* store.getServerActivity().pipe(Effect.withTracer(tracer)), "idle");
    const query = statements.find((statement) => statement.includes("WITH blockers"));
    assert.isDefined(query);
    const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
    const details = plan.map((row) => row.detail);
    assert.isFalse(
      // The blockers CTE holds at most a row per live thread; every table read must use an index.
      details.some((detail) => /^SCAN (?!CONSTANT ROW|blockers)/.test(detail)),
      details.join("\n"),
    );
    for (const name of [
      "nodes",
      "subagents",
      "turn_items",
      "provider_turns",
      "provider_threads",
      "runtime_requests",
    ]) {
      assert.isTrue(
        details.some((detail) =>
          detail.includes(`orchestration_v2_projection_${name}_activity_idx`),
        ),
        details.join("\n"),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);
