import { PlanId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  layerTest,
  driver,
  providerInstanceId,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore.testkit.ts";

// The SQL store keeps only live work beside a window's rows; the replay store's window keeps every record.
const commandReadsSkipSettledLeafNodes = Effect.fnUntraced(function* (
  windowKeepsOnlyLiveWork: boolean,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = yield* addRolledBackRecoveryCandidate("settled-leaf-nodes");
  const settledRun = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const activeRun = {
    ...settledRun,
    id: RunId.make("run:settled-leaf-nodes:active"),
    ordinal: 2,
    userMessageId: MessageId.make("message:settled-leaf-nodes:active"),
    rootNodeId: NodeId.make("node:settled-leaf-nodes:active-root"),
    status: "running" as const,
    completedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:settled-leaf-nodes:active-run"),
    type: "run.created",
    threadId,
    runId: activeRun.id,
    nodeId: activeRun.rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: activeRun,
  });
  const nodes = [
    ["settled-root", settledRun, "root_turn", "completed"],
    ["settled-tool", settledRun, "tool_call", "completed"],
    ["settled-message", settledRun, "assistant_message", "failed"],
    ["settled-reasoning", settledRun, "reasoning", "cancelled"],
    ["settled-subagent", settledRun, "subagent", "completed"],
    ["settled-run-live-tool", settledRun, "tool_call", "running"],
    ["settled-run-todo", settledRun, "todo_list", "running"],
    ["active-run-done-tool", activeRun, "tool_call", "completed"],
    ["active-run-todo", activeRun, "todo_list", "running"],
  ] as const;
  for (const [name, run, kind, status] of nodes) {
    const id = NodeId.make(`node:settled-leaf-nodes:${name}`);
    yield* store.apply({
      id: EventId.make(`event:settled-leaf-nodes:${name}`),
      type: "node.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: run.id,
        rootNodeId: kind === "root_turn" ? id : run.rootNodeId!,
        parentNodeId: kind === "root_turn" ? null : run.rootNodeId,
        kind,
        status,
        countsForRun: kind === "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
    if (kind === "todo_list") {
      yield* store.apply({
        id: EventId.make(`event:settled-leaf-nodes:${name}:plan`),
        type: "plan.updated",
        threadId,
        runId: run.id,
        nodeId: id,
        driver,
        occurredAt: now,
        payload: {
          id: PlanId.make(`plan:settled-leaf-nodes:${name}`),
          threadId,
          runId: run.id,
          nodeId: id,
          status: "active",
          kind: "todo_list",
          steps: [],
        },
      });
    }
  }
  // No row or node of this run is in the window.
  const settledCheckpointId = CheckpointId.make("checkpoint:settled-leaf-nodes:earlier-run");
  yield* store.apply({
    id: EventId.make("event:settled-leaf-nodes:earlier-run-checkpoint"),
    type: "checkpoint.captured",
    threadId,
    occurredAt: now,
    payload: {
      id: settledCheckpointId,
      threadId,
      scopeId: CheckpointScopeId.make("scope:settled-leaf-nodes:root"),
      runId: RunId.make("run:settled-leaf-nodes:earlier"),
      nodeId: NodeId.make("node:settled-leaf-nodes:earlier-root"),
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: 1,
      ref: CheckpointRef.make("refs/t3/settled-leaf-nodes/1"),
      status: "ready",
      files: [],
      capturedAt: now,
    },
  });
  const nodeNames = (records: { readonly nodes: ReadonlyArray<{ readonly id: string }> }) =>
    records.nodes
      .map((node) => node.id.replace("node:settled-leaf-nodes:", ""))
      .filter((name) => nodes.some(([candidate]) => candidate === name))
      .toSorted();

  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"], { omitSettledLeafNodes: true })),
    [
      "active-run-done-tool",
      "active-run-todo",
      "settled-root",
      "settled-run-live-tool",
      "settled-run-todo",
      "settled-subagent",
    ],
  );
  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"])),
    nodes.map(([name]) => name).toSorted(),
  );
  if (windowKeepsOnlyLiveWork) {
    // A todo list stays running after its run ends. Counted as live work, every old run of a
    // long thread would ride along with each window, with its nodes and subagents.
    const liveWindow = (yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 1 })).projection;
    assert.deepEqual(nodeNames(liveWindow), ["active-run-todo", "settled-run-live-tool"]);
    assert.deepEqual(
      liveWindow.plans.map((plan) => plan.id),
      [PlanId.make("plan:settled-leaf-nodes:active-run-todo")],
    );
    // Clients show the diff of the last finished turn from this record.
    assert.deepEqual(
      liveWindow.checkpoints.map((checkpoint) => checkpoint.id),
      [settledCheckpointId],
    );
  }

  const subagents = [
    ["delivered", settledRun, "completed", "delivered"],
    ["acknowledged", settledRun, "failed", "acknowledged"],
    ["disposed", settledRun, "cancelled", "disposed"],
    ["pending-delivery", settledRun, "completed", "pending"],
    ["claimed", settledRun, "completed", "claimed"],
    ["no-delivery", settledRun, "interrupted", null],
    ["running", settledRun, "running", null],
    ["active-run-delivered", activeRun, "completed", "delivered"],
  ] as const;
  // A follow-up reuses its task's child thread.
  const childThreadIds: Partial<Record<(typeof subagents)[number][0], ThreadId>> = {
    delivered: ThreadId.make("thread:settled-subagents:child-a"),
    running: ThreadId.make("thread:settled-subagents:child-a"),
    "no-delivery": ThreadId.make("thread:settled-subagents:child-b"),
    "active-run-delivered": ThreadId.make("thread:settled-subagents:promoted"),
  };
  for (const [index, [name, run, status, delivery]] of subagents.entries()) {
    const id = NodeId.make(`node:settled-subagents:${name}`);
    const childThreadId = childThreadIds[name] ?? null;
    yield* store.apply({
      id: EventId.make(`event:settled-subagents:item:${name}`),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:settled-subagents:${name}`),
        type: "subagent",
        threadId,
        runId: run.id,
        nodeId: id,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100 + index,
        status: status === "running" ? "running" : "completed",
        title: name,
        startedAt: now,
        completedAt: status === "running" ? null : now,
        updatedAt: now,
        subagentId: id,
        origin: "app_owned",
        driver,
        providerInstanceId,
        childThreadId,
        prompt: "Do the work",
        result: null,
      },
    });
    yield* store.apply({
      id: EventId.make(`event:settled-subagents:${name}`),
      type: "subagent.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: run.id,
        parentNodeId: run.rootNodeId!,
        origin: "app_owned",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        ...(name === "active-run-delivered" ? { promotedAt: now } : {}),
        prompt: "Do the work",
        title: name,
        model: null,
        ...(delivery === null
          ? {}
          : { completionDelivery: { state: delivery, observedByRunId: null } }),
        status,
        result: null,
        startedAt: now,
        completedAt: status === "running" ? null : now,
        updatedAt: now,
      },
    });
  }
  const subagentNames = (records: {
    readonly subagents: ReadonlyArray<{ readonly title: string | null }>;
  }) => records.subagents.map((subagent) => subagent.title ?? "").toSorted();
  assert.deepEqual(
    subagentNames(
      yield* store.getThreadRecords(threadId, ["subagents"], { omitSettledSubagents: true }),
    ),
    ["active-run-delivered", "claimed", "no-delivery", "pending-delivery", "running"],
  );
  assert.deepEqual(
    subagentNames(yield* store.getThreadRecords(threadId, ["subagents"])),
    subagents.map(([name]) => name).toSorted(),
  );
  // A command about one settled task keeps it, and reads only its node and turn item.
  const deliveredId = NodeId.make("node:settled-subagents:delivered");
  const forTask = yield* store.getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
    omitSettledSubagents: { except: [deliveredId] },
    nodeIds: [NodeId.make("node:settled-leaf-nodes:settled-tool")],
    turnItemNodeIds: [deliveredId],
  });
  assert.deepEqual(subagentNames(forTask), [
    "active-run-delivered",
    "claimed",
    "delivered",
    "no-delivery",
    "pending-delivery",
    "running",
  ]);
  assert.deepEqual(nodeNames(forTask), ["settled-tool"]);
  assert.deepEqual(
    forTask.turnItems.map((item) => item.title),
    ["delivered"],
  );
  assert.strictEqual(yield* store.getSubagentCount(threadId), subagents.length);
  assert.deepEqual(
    [...(yield* store.listAppOwnedChildThreadIds(threadId))],
    [childThreadIds.delivered, childThreadIds["no-delivery"]],
  );
});

it.effect("replay command reads retain the same live subagents as SQLite", () =>
  commandReadsSkipSettledLeafNodes(false).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("command reads skip finished leaf nodes of finished runs", () =>
    commandReadsSkipSettledLeafNodes(true),
  );
});
