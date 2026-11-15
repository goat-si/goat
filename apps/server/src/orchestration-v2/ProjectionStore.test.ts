import { PlanId } from "@goat/contracts";
import * as NodeSqlite from "node:sqlite";

import { assert, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  CommandId,
  ContextHandoffId,
  MessageId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadShellSnapshot,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2TurnItem,
  TurnItemId,
  type ThreadPullRequestLink,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectThreadAwarenessV2 } from "@goat/shared/agentAwareness";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";
import { settledParentRecovery } from "./ProjectionRecovery.testkit.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import {
  layerTest,
  modelSelection,
  driver,
  providerInstanceId,
  encodeUnknownJsonString,
  D10_NOW,
  encodeD10TurnItem,
  createD10Thread,
  d10DecisionFixture,
  d10Command,
  saveD10Request,
  saveD10Item,
  traceSqlStatements,
  addRolledBackRecoveryCandidate,
} from "./ProjectionStore.testkit.ts";

declare module "node:sqlite" {
  interface StatementSync {
    // Node 26 has this; @types/node 24 does not declare it yet.
    stat(counter: "vmStep"): number;
  }
}

const addOrphanedRecoveryCandidate = Effect.fn("addOrphanedRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:orphaned`);
  const runId = RunId.make(`run:${suffix}:missing`);
  const rootNodeId = NodeId.make(`node:${suffix}:orphaned`);

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Orphaned recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:orphaned`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "orphaned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });

  return threadId;
});

const restartCancelledWorkSurvivesStaleRunUpdate = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work-stale-update");
  const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:recorded"),
    type: "run.background-work-cancelled",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { runId: run.id, restartCancelledBackgroundWork: work },
  });
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  const updated = (yield* store.getThreadProjection(threadId)).runs[0];
  assert.equal(updated?.status, "completed");
  assert.deepEqual(updated?.restartCancelledBackgroundWork, work);
});

const threadWorktreePathsIncludeArchivedOnRequest = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (id: string, input: { worktreePath: string | null; archived?: boolean }) => {
    const threadId = ThreadId.make(id);
    const thread = {
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project:worktree-paths"),
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: input.worktreePath === null ? null : id,
      worktreePath: input.worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return store
      .apply({
        id: EventId.make(`event:${id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      })
      .pipe(Effect.as(thread));
  };
  yield* create("thread:active", { worktreePath: "/worktrees/active" });
  yield* create("thread:archived", { worktreePath: "/worktrees/archived", archived: true });
  yield* create("thread:local", { worktreePath: null });
  const deleted = yield* create("thread:deleted", { worktreePath: "/worktrees/deleted" });
  yield* store.apply({
    id: EventId.make("event:thread:deleted:deleted"),
    type: "thread.deleted",
    threadId: deleted.id,
    occurredAt: now,
    payload: { ...deleted, deletedAt: now },
  });

  assert.deepEqual(yield* store.getThreadWorktreePaths(), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
  ]);
  assert.deepEqual(yield* store.getThreadWorktreePaths({ includeArchived: true }), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
    { threadId: ThreadId.make("thread:archived"), worktreePath: "/worktrees/archived" },
  ]);
});

const commandReadsSkipSettledLeafNodes = Effect.gen(function* () {
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
    ["active-run-done-tool", activeRun, "tool_call", "completed"],
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
  }
  const nodeNames = (records: { readonly nodes: ReadonlyArray<{ readonly id: string }> }) =>
    records.nodes
      .map((node) => node.id.replace("node:settled-leaf-nodes:", ""))
      .filter((name) => nodes.some(([candidate]) => candidate === name))
      .toSorted();

  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"], { omitSettledLeafNodes: true })),
    ["active-run-done-tool", "settled-root", "settled-run-live-tool", "settled-subagent"],
  );
  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"])),
    nodes.map(([name]) => name).toSorted(),
  );

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
  commandReadsSkipSettledLeafNodes.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const backgroundThreadUpdatesKeepTimestamp = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const createdAt = DateTime.makeUnsafe("2026-10-06T14:00:00.000Z");
  const threadId = ThreadId.make("thread:background-updates");
  const thread = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id: threadId,
    projectId: ProjectId.make("project:background-updates"),
    title: "Background updates",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: thread,
  });
  const readActivity = Effect.gen(function* () {
    const projection = yield* store.getThreadProjection(threadId);
    const thread = yield* store.getThread(threadId);
    const shell = yield* store.getThreadShell(threadId);
    const listed = (yield* store.getShellSnapshot()).threads.find((entry) => entry.id === threadId);
    assert.deepEqual(projection.thread.updatedAt, createdAt);
    assert.deepEqual(thread.updatedAt, createdAt);
    assert.deepEqual(shell?.updatedAt, createdAt);
    assert.deepEqual(listed?.updatedAt, createdAt);
    return projection;
  });
  const link = {
    host: "github.com",
    repository: "owner/repository",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    source: "manual" as const,
    linkedAt: DateTime.formatIso(createdAt),
    snapshot: null,
    stack: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:pull-request-synced"),
    type: "thread.pull-request-synced",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 45 }),
    payload: { ...thread, pullRequests: [link] },
  });
  const synced = yield* readActivity;
  assert.deepEqual(synced.updatedAt, createdAt);
  assert.equal(synced.thread.pullRequests?.[0]?.number, 42);

  const snapshot = {
    state: "open" as const,
    title: "Ship it",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: DateTime.formatIso(DateTime.add(createdAt, { minutes: 46 })),
    syncedAt: DateTime.formatIso(DateTime.add(createdAt, { minutes: 47 })),
    closedAt: null,
    mergedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:pull-request-link-updated"),
    type: "thread.pull-request-link-updated",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 48 }),
    payload: { ...link, snapshot },
  });
  const refreshed = yield* readActivity;
  assert.deepEqual(refreshed.updatedAt, createdAt);
  assert.deepEqual(refreshed.thread.pullRequests?.[0]?.snapshot, snapshot);

  yield* store.apply({
    id: EventId.make("event:background-updates:active-reordered"),
    type: "thread.active-reordered",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 50 }),
    payload: { ...refreshed.thread, activeOrderKey: "a" },
  });
  const reordered = yield* readActivity;
  assert.deepEqual(reordered.updatedAt, createdAt);
  assert.equal(reordered.thread.activeOrderKey, "a");

  // An already-unpinned thread keeps its activity time even when replay's envelope advances.
  yield* store.apply({
    id: EventId.make("event:background-updates:already-unpinned"),
    type: "thread.unpinned",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 55 }),
    payload: { ...reordered.thread, pinnedAt: null, pinOrderKey: null },
  });
  yield* readActivity;
});

it.effect("SQL projection keeps background thread updates out of updatedAt", () =>
  backgroundThreadUpdatesKeepTimestamp.pipe(Effect.provide(layerTest)),
);

it.effect("memory recovery selection includes unfinished items from missing runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addOrphanedRecoveryCandidate("memory-recovery-candidates");

    assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const runlessNativeSubagentNeedsRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("runless-native-recovery");
  const now = yield* DateTime.now;
  const id = NodeId.make("node:runless-native-recovery");
  assert.notInclude(yield* store.getRecoveryThreadIds("runtime"), threadId);
  for (const status of ["pending", "running", "waiting", "completed"] as const) {
    yield* store.apply({
      id: EventId.make(`event:runless-native-recovery:${status}`),
      type: "subagent.updated",
      threadId,
      nodeId: id,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:runless-native-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: { driver, nativeId: "runless-native", strength: "strong" },
        prompt: "Do the work",
        title: "Workflow member",
        model: null,
        status,
        result: null,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
      },
    });
    assert.equal(
      (yield* store.getRecoveryThreadIds("runtime")).includes(threadId),
      status !== "completed",
    );
  }
});

const assertProjectScopedShells = Effect.fn("assertProjectScopedShells")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const projectId = ProjectId.make(`project:${suffix}:a`);
  const otherProjectId = ProjectId.make(`project:${suffix}:b`);
  const activeThreadId = ThreadId.make(`thread:${suffix}:a-active`);
  const archivedThreadId = ThreadId.make(`thread:${suffix}:a-archived`);
  const forkThreadId = ThreadId.make(`thread:${suffix}:a-fork`);
  const sourceThreadId = ThreadId.make(`thread:${suffix}:b-source`);
  const otherThreadId = ThreadId.make(`thread:${suffix}:b-other`);
  const sourceRunId = RunId.make(`run:${suffix}:b-source`);
  const sourceNodeId = NodeId.make(`node:${suffix}:b-source`);
  const createThread = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly archived?: boolean;
    readonly forkedFromRunOf?: ThreadId;
  }) =>
    projectionStore.apply({
      id: EventId.make(`event:${input.threadId}:created`),
      type: "thread.created",
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: input.threadId,
        projectId: input.projectId,
        title: input.threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage:
          input.forkedFromRunOf === undefined
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
            : {
                parentThreadId: input.forkedFromRunOf,
                relationshipToParent: "fork",
                rootThreadId: input.forkedFromRunOf,
              },
        forkedFrom:
          input.forkedFromRunOf === undefined
            ? null
            : { type: "run", threadId: input.forkedFromRunOf, runId: sourceRunId },
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  yield* createThread({ threadId: sourceThreadId, projectId: otherProjectId, archived: true });
  yield* createThread({ threadId: otherThreadId, projectId: otherProjectId });
  yield* createThread({ threadId: activeThreadId, projectId });
  yield* createThread({ threadId: archivedThreadId, projectId, archived: true });
  yield* createThread({ threadId: forkThreadId, projectId, forkedFromRunOf: sourceThreadId });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-run`),
    type: "run.created",
    threadId: sourceThreadId,
    runId: sourceRunId,
    nodeId: sourceNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: sourceRunId,
      threadId: sourceThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${suffix}:source-user`),
      rootNodeId: sourceNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-item`),
    type: "turn-item.updated",
    threadId: sourceThreadId,
    runId: sourceRunId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:${suffix}:source`),
      threadId: sourceThreadId,
      runId: sourceRunId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(`message:${suffix}:source-assistant`),
      text: "Source answer",
      streaming: false,
    },
  });
  const unscoped = yield* projectionStore.getShellSnapshot();
  const inProject = (thread: { readonly projectId: ProjectId }) => thread.projectId === projectId;
  const active = yield* projectionStore.getShellSnapshot({ projectId, location: "active" });
  assert.deepEqual(active.threads, unscoped.threads.filter(inProject));
  assert.deepEqual(active.archivedThreads, []);
  assert.sameMembers(
    active.threads.map((thread) => thread.id),
    [activeThreadId, forkThreadId],
  );
  const fork = active.threads.find((thread) => thread.id === forkThreadId);
  assert.isAbove(fork?.visibleItemCount ?? 0, 0);
  const all = yield* projectionStore.getShellSnapshot({ projectId });
  assert.deepEqual(all.threads, active.threads);
  assert.deepEqual(all.archivedThreads, unscoped.archivedThreads.filter(inProject));
  assert.sameMembers(
    all.archivedThreads.map((thread) => thread.id),
    [archivedThreadId],
  );
  const missingThreadId = ThreadId.make(`thread:${suffix}:missing`);
  const targeted = yield* projectionStore.getShellSnapshot({
    threadIds: [forkThreadId, archivedThreadId, missingThreadId],
  });
  for (const threadId of [forkThreadId, archivedThreadId, missingThreadId]) {
    assert.deepEqual(
      [...targeted.threads, ...targeted.archivedThreads].find((shell) => shell.id === threadId) ??
        null,
      yield* projectionStore.getThreadShell(threadId),
    );
  }
  return { projectId, activeThreadId, forkThreadId, otherThreadId };
});
it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s shells read a subagent family and a worktree's threads", ([kind, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:family");
    const worktreePath = "/repo/.t3/worktrees/family";
    const id = (name: string) => ThreadId.make(`thread:family:${name}`);
    const payloadOf = (input: {
      readonly name: string;
      readonly parent?: string;
      readonly root?: string;
      readonly worktreePath?: string;
      readonly archived?: boolean;
    }) =>
      ({
        createdBy: "user",
        creationSource: input.parent === undefined ? "web" : "mcp",
        id: id(input.name),
        projectId,
        title: input.name,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: input.worktreePath ?? null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.parent === undefined ? null : id(input.parent),
          relationshipToParent: input.parent === undefined ? null : "subagent",
          rootThreadId: id(input.root ?? input.name),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      }) as const;
    const createThread = (input: Parameters<typeof payloadOf>[0]) =>
      store.apply({
        id: EventId.make(`event:family:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: payloadOf(input),
      });
    yield* createThread({ name: "root", worktreePath });
    yield* createThread({ name: "child", parent: "root", root: "root", worktreePath });
    yield* createThread({ name: "grandchild", parent: "child", root: "root" });
    yield* createThread({ name: "archived-child", parent: "root", root: "root", archived: true });
    yield* createThread({ name: "other", worktreePath: "/repo" });
    yield* createThread({ name: "other-child", parent: "other", root: "other", worktreePath });
    const family = (threadId: ThreadId) =>
      store
        .getShellSnapshot({ location: "active", familyOf: threadId })
        .pipe(Effect.map((snapshot) => snapshot.threads.map((thread) => thread.id)));
    // Any member, or the root itself, names the same active tree, root included.
    const tree = [id("root"), id("child"), id("grandchild")];
    assert.sameMembers([...(yield* family(id("root")))], tree);
    assert.sameMembers([...(yield* family(id("grandchild")))], tree);
    assert.deepEqual([...(yield* family(id("missing")))], []);
    // Includes another root's idle child on the same path, which a shell may leave out.
    const { statements, tracer } = traceSqlStatements();
    const onWorktree = yield* store
      .getShellSnapshot({ location: "active", worktreePath })
      .pipe(Effect.withTracer(tracer));
    assert.sameMembers(
      onWorktree.threads.map((thread) => thread.id),
      [id("root"), id("child"), id("other-child")],
    );
    // A path names a few threads; scanning every thread parses every payload.
    const sqlClient = yield* Effect.serviceOption(SqlClient.SqlClient);
    if (kind === "SQL") {
      const sql = Option.getOrThrow(sqlClient);
      const threadQuery = statements.find((statement) =>
        statement.includes("AS latest_run_stop_requested"),
      );
      assert.isDefined(threadQuery);
      const threadPlan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${threadQuery}`,
        [],
      )).map((row) => row.detail);
      assert.notInclude(threadPlan, "SCAN t", threadPlan.join("\n"));
    }
    // A fork keeps its deleted source's root, so the deleted root still names the live tree.
    yield* store.apply({
      id: EventId.make("event:family:root-deleted"),
      type: "thread.deleted",
      threadId: id("root"),
      occurredAt: now,
      payload: { ...payloadOf({ name: "root", worktreePath }), deletedAt: now },
    });
    assert.sameMembers([...(yield* family(id("root")))], [id("child"), id("grandchild")]);
  }).pipe(Effect.provide(layer)),
);
it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s list older settled threads below a cursor", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const id = (name: string) => ThreadId.make(`thread:older:${name}`);
    const at = (day: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, day));
    const createThread = (input: {
      readonly name: string;
      readonly settledDay: number | null;
      readonly project?: string;
      readonly subagent?: boolean;
      readonly sideChat?: boolean;
      readonly archived?: boolean;
      readonly snoozedUntilDay?: number;
    }) =>
      store.apply({
        id: EventId.make(`event:older:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: id(input.name),
          projectId: ProjectId.make(input.project ?? "project:a"),
          title: input.name,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: input.subagent === true ? id("b") : null,
            relationshipToParent: input.subagent === true ? "subagent" : null,
            rootThreadId: input.subagent === true ? id("b") : id(input.name),
          },
          forkedFrom: null,
          ...(input.sideChat ? { sideChatOf: id("b") } : {}),
          createdAt: now,
          updatedAt: now,
          archivedAt: input.archived === true ? now : null,
          settledOverride: input.settledDay === null ? null : "settled",
          settledAt: input.settledDay === null ? null : at(input.settledDay),
          snoozedUntil: input.snoozedUntilDay === undefined ? null : at(input.snoozedUntilDay),
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
    yield* createThread({ name: "a", settledDay: 5 });
    yield* createThread({ name: "b", settledDay: 4 });
    yield* createThread({ name: "c", settledDay: 4 });
    yield* createThread({ name: "d", settledDay: 3, project: "project:b" });
    yield* createThread({ name: "snoozed", settledDay: 2, snoozedUntilDay: 30 });
    yield* createThread({ name: "recent", settledDay: 20 });
    yield* createThread({ name: "unsettled", settledDay: null });
    yield* createThread({ name: "child", settledDay: 1, subagent: true });
    yield* createThread({ name: "archived", settledDay: 1, archived: true });
    yield* createThread({ name: "side", settledDay: 1, sideChat: true });

    const list = (
      before: { readonly settledAt: string; readonly threadId?: ThreadId },
      limit: number,
      projectIds?: ReadonlyArray<ProjectId>,
    ) => store.listOlderSettledThreads({ before, projectIds, limit });
    const before = { settledAt: DateTime.formatIso(at(10)) };
    const first = yield* list(before, 2);
    assert.deepEqual(first, { threadIds: [id("a"), id("b")], counts: [] });
    assert.sameDeepMembers(
      [...(yield* list(before, 0)).counts],
      [
        { projectId: ProjectId.make("project:a"), count: 5 },
        { projectId: ProjectId.make("project:b"), count: 1 },
      ],
    );
    assert.deepEqual((yield* list(before, 0)).sideChatCounts, [
      { projectId: ProjectId.make("project:a"), count: 1 },
    ]);
    // A cursor without an id is strict, as the snapshot's cut is: the day-4 tie is not counted.
    assert.sameDeepMembers(
      [...(yield* list({ settledAt: DateTime.formatIso(at(4)) }, 0)).counts],
      [
        { projectId: ProjectId.make("project:a"), count: 2 },
        { projectId: ProjectId.make("project:b"), count: 1 },
      ],
    );
    // The cursor is the last row: the tie on day 4 continues by id.
    const next = yield* list({ settledAt: DateTime.formatIso(at(4)), threadId: id("b") }, 10);
    assert.deepEqual(next.threadIds, [id("c"), id("d"), id("snoozed"), id("side")]);
    assert.deepEqual(yield* list(before, 25, []), { threadIds: [], counts: [] });
    const scoped = yield* list(before, 0, [ProjectId.make("project:b")]);
    assert.deepEqual(scoped, {
      threadIds: [],
      counts: [{ projectId: ProjectId.make("project:b"), count: 1 }],
      sideChatCounts: [],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("SQL snapshot windows leave handoff bodies in SQLite without changing the wire", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:handoff-window");
    yield* store.apply({
      id: EventId.make("event:handoff-window:thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project:handoff-window"),
        title: "Handoff window",
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
      },
    });
    const providerThreadId = ProviderThreadId.make("provider-thread:handoff-window");
    const earlierItemId = TurnItemId.make("item:handoff-window:earlier");
    const handoff = (id: string, status: "ready" | "superseded") => ({
      id: ContextHandoffId.make(`handoff:handoff-window:${id}`),
      transferId: null,
      threadId,
      targetRunId: RunId.make("run:handoff-window"),
      fromProviderThreadIds: [providerThreadId],
      toProviderThreadId: providerThreadId,
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary" as const,
      status,
      summaryMessageId: null,
      summaryText: `Summary ${id}`,
      history: {
        messages: [
          {
            role: "user" as const,
            text: "Earlier request ".repeat(1_000),
            threadId,
            runId: null,
            itemId: earlierItemId,
            providerThreadId,
            status: "completed",
            kind: "user_message",
          },
        ],
        coverage: "full",
        omittedItems: 0,
      },
      delivery: { nativeThreadId: "native", status: "injected" as const, itemIds: [earlierItemId] },
      createdByProviderInstanceId: providerInstanceId,
      createdAt: now,
      updatedAt: now,
    });
    // The window keeps a ready handoff and one its rows show; the third is outside it.
    const handoffs = [
      handoff("ready", "ready"),
      handoff("shown", "superseded"),
      handoff("old", "superseded"),
    ];
    for (const payload of handoffs) {
      yield* store.apply({
        id: EventId.make(`event:${payload.id}`),
        type: "context-handoff.updated",
        threadId,
        occurredAt: now,
        payload,
      });
    }
    yield* store.apply({
      id: EventId.make("event:handoff-window:item"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("item:handoff-window:handoff"),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "handoff",
        contextHandoffId: handoffs[1]!.id,
        fromProviderThreadIds: [providerThreadId],
        toProviderThreadId: providerThreadId,
        fromProviderInstanceIds: [providerInstanceId],
        toProviderInstanceId: providerInstanceId,
        strategy: "full_thread_summary",
      },
    });

    const window = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 10 });
    const windowHandoffs = window.projection.contextHandoffs;
    assert.deepEqual(
      windowHandoffs.map((row) => row.id),
      [handoffs[0]!.id, handoffs[1]!.id],
    );
    for (const row of windowHandoffs) {
      assert.isUndefined(row.history);
      assert.isUndefined(row.delivery);
    }
    const full = yield* store.getThreadSnapshot(threadId);
    assert.deepEqual(full.projection.contextHandoffs, handoffs);
    assert.deepEqual(
      buildBoundedThreadStreamSnapshot(window),
      buildBoundedThreadStreamSnapshot({
        ...window,
        projection: { ...window.projection, contextHandoffs: handoffs.slice(0, 2) },
      }),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lists only active subagent IDs without loading shell data", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const createdAt = "2026-01-05T00:00:00.000Z";
    for (const [id, relationship, archivedAt, deletedAt] of [
      ["parent", null, null, null],
      ["active-subagent", "subagent", null, null],
      ["active-subagent-2", "subagent", null, null],
      ["archived-subagent", "subagent", createdAt, null],
      ["deleted-subagent", "subagent", null, createdAt],
    ] as const) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${id}, 'project:test', ${id}, 'codex', 'full-access', 'default',
          ${createdAt}, ${createdAt}, ${archivedAt}, ${deletedAt},
          ${JSON.stringify({ lineage: { relationshipToParent: relationship }, archivedAt })}
        )
      `;
    }

    assert.sameMembers(
      [...(yield* store.listActiveSubagentThreadIds())],
      [ThreadId.make("active-subagent"), ThreadId.make("active-subagent-2")],
    );
    assert.deepEqual(yield* store.listActiveSubagentThreadIds({ limit: 1 }), [
      ThreadId.make("active-subagent"),
    ]);
    assert.deepEqual(
      yield* store.listActiveSubagentThreadIds({
        limit: 1,
        after: ThreadId.make("active-subagent"),
      }),
      [ThreadId.make("active-subagent-2")],
    );
  }).pipe(Effect.provide(layerTest)),
);

// regression: #25621 SQLite rejects statements binding more than 32,766 variables
it.effect("lists every thread in the shell snapshot past SQLite's bound variable limit", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const templateId = ThreadId.make("thread:many:00000");
    yield* store.apply({
      id: EventId.make(`event:${templateId}:created`),
      type: "thread.created",
      threadId: templateId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: templateId,
        projectId: ProjectId.make("project:many"),
        title: "Many",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: templateId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const threadCount = 32_767;
    yield* sql`
      CREATE TEMP TABLE many_threads AS
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${threadCount - 1})
      SELECT t.*, n.i AS clone_index FROM orchestration_v2_projection_threads t, n
      WHERE t.thread_id = ${templateId}
    `;
    yield* sql`
      UPDATE many_threads SET
        thread_id = printf('thread:many:%05d', clone_index),
        payload_json = json_set(
          payload_json,
          '$.id', printf('thread:many:%05d', clone_index),
          '$.lineage.rootThreadId', printf('thread:many:%05d', clone_index)
        )
    `;
    yield* sql`ALTER TABLE many_threads DROP COLUMN clone_index`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM many_threads`;

    const [unscoped, active] = yield* Effect.all([
      store.getShellSnapshot(),
      store.getShellSnapshot({ location: "active" }),
    ]);
    assert.strictEqual(unscoped.threads.length, threadCount);
    assert.strictEqual(active.threads.length, threadCount);
    assert.strictEqual(yield* store.countThreads(), threadCount);
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  // regression: #25157 streamed payloads are not re-parsed to read their indexed timestamps
  it.effect("indexes streamed payload timestamps without parsing the payload JSON", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("streamed-payload-parse");
      const runId = RunId.make("run:streamed-payload-parse:rolled-back");
      const createdAt = DateTime.makeUnsafe("2026-01-02T03:04:05.006Z");
      const updatedAt = DateTime.makeUnsafe("2026-01-02T03:04:06.007Z");
      const text = "x".repeat(128 * 1024);
      const messageId = MessageId.make("message:streamed-payload-parse");
      const itemId = TurnItemId.make("item:streamed-payload-parse");

      const parsedPayloads = yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(JSON, "parse")),
        (parse) =>
          Effect.gen(function* () {
            yield* store.apply({
              id: EventId.make("event:streamed-payload-parse:message"),
              type: "message.updated",
              threadId,
              occurredAt: updatedAt,
              payload: {
                createdBy: "agent",
                creationSource: "server",
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "assistant",
                text,
                attachments: [],
                streaming: true,
                createdAt,
                updatedAt,
              },
            });
            yield* store.apply({
              id: EventId.make("event:streamed-payload-parse:item"),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: updatedAt,
              payload: {
                id: itemId,
                threadId,
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                type: "assistant_message",
                status: "running",
                title: "Assistant",
                messageId,
                text,
                streaming: true,
                startedAt: createdAt,
                completedAt: null,
                updatedAt,
              },
            });
            return parse.mock.calls
              .filter(([json]) => typeof json === "string" && json.includes(text))
              .map(([json]) => (JSON.parse(json) as { readonly id: string }).id);
          }),
        (parse) => Effect.sync(() => parse.mockRestore()),
      );

      assert.deepStrictEqual(parsedPayloads, []);
      assert.deepStrictEqual(
        yield* sql`
          SELECT created_at, updated_at FROM orchestration_v2_projection_messages
          WHERE message_id = ${messageId}
        `,
        [{ created_at: DateTime.formatIso(createdAt), updated_at: DateTime.formatIso(updatedAt) }],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT updated_at FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `,
        [{ updated_at: DateTime.formatIso(updatedAt) }],
      );
    }),
  );

  it.effect(
    "SQL recovery selects unfinished runless native subagents",
    () => runlessNativeSubagentNeedsRecovery,
  );
  it.effect(
    "worktree path lookup defaults to active threads and can include archived threads",
    () => threadWorktreePathsIncludeArchivedOnRequest,
  );

  it.effect(
    "keeps restart-cancelled work through a stale run.updated",
    () => restartCancelledWorkSurvivesStaleRunUpdate,
  );
  it.effect("records restart-cancelled work without regressing a run that completed since", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work");
      const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:recorded"),
        type: "run.background-work-cancelled",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { runId: run.id, restartCancelledBackgroundWork: work },
      });
      const recorded = (yield* store.getThreadProjection(threadId)).runs[0];
      assert.equal(recorded?.status, "completed");
      assert.deepEqual(recorded?.restartCancelledBackgroundWork, work);
      const [recovery] = (yield* store.getThreadRecords(threadId, ["runs"], {
        runIds: [run.id],
      })).runs;
      assert.equal(recovery?.status, "completed");
      assert.deepEqual(recovery?.restartCancelledBackgroundWork, work);
    }),
  );
  it.effect(
    "command reads skip finished leaf nodes of finished runs",
    () => commandReadsSkipSettledLeafNodes,
  );

  it.effect("preserves stored provider usage when a terminal update omits it", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-usage-reload");
      const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
      const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
      const nodeId = NodeId.make("node:provider-usage-reload");
      const initialUsage = {
        usedTokens: 12_000,
        maxTokens: 200_000,
        inputTokens: 11_000,
        outputTokens: 1_000,
        updatedAt: "2026-08-29T12:00:00.000Z",
      } as const;
      const replacementUsage = {
        usedTokens: 18_000,
        maxTokens: 200_000,
        inputTokens: 16_000,
        outputTokens: 2_000,
        updatedAt: "2026-08-29T12:00:01.000Z",
      } as const;

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-usage-reload"),
          title: "Provider usage reload",
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
        },
      });

      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:running"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, tokenUsage: initialUsage },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:completed"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, status: "completed", completedAt: now },
      });

      const reloaded = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, initialUsage);
      assert.strictEqual(reloaded.providerTurns[0]?.status, "completed");

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:replacement"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: "completed",
          completedAt: now,
          tokenUsage: replacementUsage,
        },
      });

      const replaced = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
    }),
  );

  it.effect(
    "retains pending decision bodies through SQL and bounded paging without exposing dependencies",
    () =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = yield* createD10Thread("d10-pending-window");
        const { question, approval, requests } = d10DecisionFixture(threadId, "d10-pending-window");
        for (const request of requests) yield* saveD10Request(threadId, request);
        for (const item of [question, approval]) yield* saveD10Item(item);
        for (let ordinal = 3; ordinal <= 10; ordinal += 1) {
          yield* saveD10Item(d10Command(threadId, "d10-pending-window", ordinal));
        }
        const otherThreadId = yield* createD10Thread("d10-other-thread");
        const unrelated = d10DecisionFixture(otherThreadId, "d10-other-thread");
        for (const request of unrelated.requests) yield* saveD10Request(otherThreadId, request);
        yield* saveD10Item(unrelated.question);
        yield* saveD10Item(unrelated.approval);
        const snapshot = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 2 });
        assert.deepEqual(
          snapshot.projection.turnItems.map((item) => item.id),
          [
            "d10-pending-window:question-item",
            "d10-pending-window:approval-item",
            "d10-pending-window:item:9",
            "d10-pending-window:item:10",
          ],
        );
        assert.deepEqual(snapshot.projection.turnItems[0], question);
        assert.deepEqual(snapshot.projection.turnItems[1], approval);
        assert.deepEqual(
          snapshot.projection.visibleTurnItems.map((row) => row.item.ordinal),
          [9, 10],
        );
        assert.isTrue(snapshot.projection.turnItems.every((item) => item.threadId === threadId));
        const bounded = buildBoundedThreadProjection({
          projection: snapshot.projection,
          snapshotSequence: snapshot.snapshotSequence,
          policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
        });
        assert.deepEqual(
          bounded.projection.visibleTurnItems.map((row) => row.item.ordinal),
          [10],
        );
        assert.deepEqual(
          bounded.projection.turnItems.map((item) => item.id),
          [
            "d10-pending-window:item:10",
            "d10-pending-window:question-item",
            "d10-pending-window:approval-item",
          ],
        );
        assert.deepEqual(bounded.projection.turnItems[1], question);
        assert.deepEqual(bounded.projection.turnItems[2], approval);
        assert.isTrue(bounded.hasMoreHistory);
        assert.isNotNull(bounded.historyCursor);
        assert.equal(
          decodeThreadHistoryCursor(bounded.historyCursor!).si,
          "d10-pending-window:item:10",
        );
        const all = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 10 });
        const expectedIds = [
          "d10-pending-window:question-item",
          "d10-pending-window:approval-item",
          "d10-pending-window:item:3",
          "d10-pending-window:item:4",
          "d10-pending-window:item:5",
          "d10-pending-window:item:6",
          "d10-pending-window:item:7",
          "d10-pending-window:item:8",
          "d10-pending-window:item:9",
          "d10-pending-window:item:10",
        ];
        assert.deepEqual(
          all.projection.turnItems.map((item) => item.id),
          expectedIds,
        );
        assert.deepEqual(
          all.projection.visibleTurnItems.map((row) => row.sourceItemId),
          expectedIds,
        );

        const initial = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 4 });
        const initialBounded = buildBoundedThreadProjection({
          projection: initial.projection,
          snapshotSequence: initial.snapshotSequence,
          policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
        });
        assert.deepEqual(
          initialBounded.projection.visibleTurnItems.map((row) => row.item.ordinal),
          [9, 10],
        );
        assert.isTrue(initialBounded.hasMoreHistory);
        assert.deepEqual(
          initialBounded.projection.turnItems.filter(
            (item) => item.type === "user_input_request" || item.type === "approval_request",
          ),
          [question, approval],
        );
        const loaded = [...initialBounded.projection.visibleTurnItems];
        let cursor = initialBounded.historyCursor;
        while (cursor !== null) {
          const anchor = decodeThreadHistoryCursor(cursor);
          const anchored = yield* store.getThreadSnapshotWindow(threadId, {
            rowLimit: 4,
            anchorItemId: TurnItemId.make(anchor.si),
          });
          const page = selectHistoryPageFromCursor({
            items: anchored.projection.visibleTurnItems,
            cursor,
            snapshotSequence: anchored.snapshotSequence,
            policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
          });
          const anchorOrdinal = all.projection.turnItems.find(
            (item) => item.id === anchor.si,
          )!.ordinal;
          assert.isTrue(page.items.every((row) => row.item.ordinal < anchorOrdinal));
          loaded.unshift(...page.items);
          assert.isBelow(loaded.length, 11);
          cursor = page.nextCursor;
        }
        assert.deepEqual(
          loaded.map((row) => row.sourceItemId),
          expectedIds,
        );
        assert.equal(new Set(loaded.map((row) => row.sourceItemId)).size, 10);

        // A new pending body may ride in control state even when newer than the page anchor.
        const third = {
          ...approval,
          id: TurnItemId.make("d10-pending-window:late-approval-item"),
          requestId: RuntimeRequestId.make("d10-pending-window:late-approval"),
          ordinal: 11,
        };
        yield* saveD10Item(third);
        yield* saveD10Request(threadId, { ...requests[1]!, id: third.requestId });
        const anchored = yield* store.getThreadSnapshotWindow(threadId, {
          rowLimit: 4,
          anchorItemId: TurnItemId.make("d10-pending-window:item:10"),
        });
        assert.deepEqual(
          anchored.projection.turnItems.find((item) => item.id === third.id),
          third,
        );
        const older = selectHistoryPageFromCursor({
          items: anchored.projection.visibleTurnItems,
          cursor: bounded.historyCursor!,
          snapshotSequence: anchored.snapshotSequence,
          policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
        });
        assert.deepEqual(
          older.items.map((row) => row.item.ordinal),
          [8, 9],
        );
        assert.isFalse(older.items.some((row) => row.sourceItemId === third.id));

        yield* saveD10Request(threadId, {
          ...requests[0]!,
          status: "resolved",
          resolvedAt: D10_NOW,
        });
        yield* saveD10Request(threadId, {
          ...requests[1]!,
          status: "expired",
          resolvedAt: D10_NOW,
        });
        const resolved = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 2 });
        assert.deepEqual(
          resolved.projection.turnItems.map((item) => item.id),
          ["d10-pending-window:item:10", "d10-pending-window:late-approval-item"],
        );
        assert.isFalse(
          resolved.projection.turnItems.some((item) => item.threadId === otherThreadId),
        );
      }),
  );

  it.effect("seeks retained pending bodies by thread and request ID in long histories", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* createD10Thread("d10-long-history");
      const otherThreadId = yield* createD10Thread("d10-long-other");
      const { question, approval, requests } = d10DecisionFixture(threadId, "d10-long-history");
      for (const request of requests)
        yield* saveD10Request(threadId, { ...request, status: "resolved", resolvedAt: D10_NOW });
      const unrelated = d10DecisionFixture(otherThreadId, "d10-long-other");
      for (const request of unrelated.requests) yield* saveD10Request(otherThreadId, request);
      const items = [
        question,
        approval,
        ...Array.from({ length: 9_998 }, (_, index) =>
          d10Command(threadId, "d10-long-history", index + 3),
        ),
        unrelated.question,
        unrelated.approval,
        ...Array.from({ length: 100 }, (_, index) =>
          d10Command(otherThreadId, "d10-long-other", index + 3),
        ),
      ];
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (let offset = 0; offset < items.length; offset += 50) {
            const rows = items.slice(offset, offset + 50).map((item) => ({
              turn_item_id: item.id,
              thread_id: item.threadId,
              run_id: item.runId,
              node_id: item.nodeId,
              provider_thread_id: item.providerThreadId,
              provider_turn_id: item.providerTurnId,
              parent_item_id: item.parentItemId,
              ordinal: item.ordinal,
              type: item.type,
              status: item.status,
              updated_at: DateTime.formatIso(item.updatedAt),
              payload_json: encodeD10TurnItem(item),
            }));
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
          }
        }),
      );
      const { statements, tracer } = traceSqlStatements();
      const explainRetention = () =>
        Effect.gen(function* () {
          const statement = statements.findLast((query) =>
            query.includes("retained AS MATERIALIZED"),
          );
          assert.isDefined(statement);
          return yield* sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`);
        });
      const assertPlan = (plan: ReadonlyArray<{ readonly detail: string }>) => {
        const retentionPlan = plan.filter((row) =>
          /(?:pending_request|request_item)\b/.test(row.detail),
        );
        assert.lengthOf(retentionPlan, 2);
        assert.match(
          retentionPlan[0]!.detail,
          /SEARCH pending_request USING INDEX orchestration_v2_projection_runtime_requests_thread_status_idx \(thread_id=\? AND status=\?\)/,
        );
        assert.match(
          retentionPlan[1]!.detail,
          /SEARCH request_item USING INDEX orchestration_v2_projection_turn_items_thread_request_idx \(thread_id=\? AND <expr>=\?\)/,
        );
        assert.isFalse(retentionPlan.some((row) => /SCAN request_item/.test(row.detail)));
        assert.isFalse(
          retentionPlan.some((row) => row.detail.includes("turn_items_thread_ordinal_idx")),
        );
      };
      const empty = yield* store
        .getThreadSnapshotWindow(threadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        empty.projection.turnItems.map((item) => item.id),
        ["d10-long-history:item:9999", "d10-long-history:item:10000"],
      );
      assert.deepEqual(
        empty.projection.visibleTurnItems.map((row) => row.item.ordinal),
        [9_999, 10_000],
      );
      assertPlan(yield* explainRetention());
      // Each pending request seeks its own body without walking the thread's history.
      yield* saveD10Request(threadId, requests[0]!);
      const pending = yield* store
        .getThreadSnapshotWindow(threadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        pending.projection.turnItems.map((item) => item.id),
        [
          "d10-long-history:question-item",
          "d10-long-history:item:9999",
          "d10-long-history:item:10000",
        ],
      );
      assert.deepEqual(pending.projection.turnItems[0], question);
      assert.deepEqual(
        pending.projection.visibleTurnItems.map((row) => row.item.ordinal),
        [9_999, 10_000],
      );
      assert.isTrue(pending.projection.turnItems.every((item) => item.threadId === threadId));
      assertPlan(yield* explainRetention());
      yield* saveD10Request(threadId, requests[1]!);
      const bothPending = yield* store
        .getThreadSnapshotWindow(threadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        bothPending.projection.turnItems.map((item) => item.id),
        [
          "d10-long-history:question-item",
          "d10-long-history:approval-item",
          "d10-long-history:item:9999",
          "d10-long-history:item:10000",
        ],
      );
      assert.deepEqual(bothPending.projection.turnItems.slice(0, 2), [question, approval]);
      assert.deepEqual(
        bothPending.projection.visibleTurnItems.map((row) => row.item.ordinal),
        [9_999, 10_000],
      );
      assertPlan(yield* explainRetention());
    }),
  );

  it.effect("does not import pending request bodies after a parent's fork boundary", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = yield* createD10Thread("d10-fork-parent");
      const sourceRunId = RunId.make("d10-fork-parent:run:1");
      const laterRunId = RunId.make("d10-fork-parent:run:2");
      for (const [runId, ordinal] of [
        [sourceRunId, 1],
        [laterRunId, 2],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId: NodeId.make(`${runId}:node`),
          driver,
          providerInstanceId,
          occurredAt: D10_NOW,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`${runId}:message`),
            rootNodeId: NodeId.make(`${runId}:node`),
            activeAttemptId: null,
            status: "completed",
            requestedAt: D10_NOW,
            startedAt: D10_NOW,
            completedAt: D10_NOW,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
      }
      const historical = {
        ...d10Command(sourceThreadId, "d10-fork-parent", 1),
        runId: sourceRunId,
      };
      yield* saveD10Item(historical);
      const { approval, requests } = d10DecisionFixture(sourceThreadId, "d10-fork-parent");
      const late = { ...approval, ordinal: 2, runId: laterRunId };
      yield* saveD10Item(late);
      yield* saveD10Request(sourceThreadId, requests[1]!);
      const targetThreadId = yield* createD10Thread("d10-fork-child", {
        type: "run",
        threadId: sourceThreadId,
        runId: sourceRunId,
      });
      const snapshot = yield* store.getThreadSnapshotWindow(targetThreadId, { rowLimit: 2 });
      assert.deepEqual(
        snapshot.projection.visibleTurnItems.map((row) => row.item.type),
        ["command_execution", "fork"],
      );
      assert.equal(snapshot.projection.visibleTurnItems[0]?.sourceItemId, "d10-fork-parent:item:1");
      assert.isFalse(
        snapshot.projection.visibleTurnItems.some((row) => row.sourceItemId === late.id),
      );
      assert.deepEqual(snapshot.projection.turnItems, []);
      assert.deepEqual(snapshot.projection.runtimeRequests, []);
    }),
  );

  it.effect("reads a fixed SQL turn-item window for long histories and repeated clients", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-sql-history");
      // The raw SQL edits below stand in for committed writes, which always append a thread event.
      let revision = 0;
      const historyPage = (...args: Parameters<typeof projectionStore.getThreadHistoryPage>) =>
        sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`event:bounded-sql-history:revision:${++revision}`}, 'thread', ${threadId}, ${revision},
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )`.pipe(Effect.andThen(projectionStore.getThreadHistoryPage(...args)));
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-sql-history"),
          title: "Bounded SQL history",
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
        },
      });

      for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:${ordinal}`;
        const runId = `run:bounded-sql-history:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:bounded-sql-history:${ordinal}`,
              rootNodeId: `node:bounded-sql-history:${ordinal}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const snapshots = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 }),
        ),
        { concurrency: 4 },
      );
      for (const snapshot of snapshots) {
        assert.lengthOf(snapshot.projection.turnItems, 76);
        assert.lengthOf(snapshot.projection.runs, 76);
        assert.lengthOf(snapshot.projection.visibleTurnItems, 76);
        assert.strictEqual(snapshot.projection.turnItems[0]?.ordinal, 925);
        assert.strictEqual(snapshot.projection.turnItems.at(-1)?.ordinal, 1_000);
      }
      const setTurnType = (
        type: "command_execution" | "user_message",
        start: number,
        end = start,
      ) => sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = ${type}, payload_json = json_set(payload_json,
          '$.type', ${type}, '$.createdBy', 'user', '$.creationSource', 'web',
          '$.inputIntent', 'turn_start', '$.messageId', turn_item_id, '$.text', 'Turn',
          '$.attachments', json('[]'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN ${start} AND ${end}
      `;
      for (const ordinal of [1, 1000]) yield* setTurnType("user_message", ordinal);
      const humanWindow = () =>
        projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
      assert.lengthOf(
        (yield* humanWindow()).projection.turnItems,
        THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
      );
      // With the newest user turn 1,000 rows back, the window pages from inside it.
      yield* setTurnType("command_execution", 1000);
      assert.lengthOf((yield* humanWindow()).projection.turnItems, 77);
      yield* setTurnType("user_message", 1000);

      // Fewer than 75 rows still need a byte pass after materializing wire payloads.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'assistant_message', payload_json = json_set(payload_json,
          '$.type', 'assistant_message', '$.text', ${"x".repeat(40_000)},
          '$.messageId', turn_item_id, '$.streaming', json('false'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 2 AND 70
      `;
      const byteCursor = encodeThreadHistoryCursor({
        snapshotSequence: 0,
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:71"),
        position: 70,
      });
      const bytePage = yield* historyPage(threadId, byteCursor);
      assert.isAbove(bytePage.items.length, 0);
      assert.isBelow(bytePage.items.length, 70);
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(bytePage.items), "utf8"),
        THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
      );
      const byteIds = bytePage.items.map((row) => String(row.sourceItemId));
      let byteNext = bytePage.nextCursor;
      for (let pages = 0; byteNext !== null; pages += 1) {
        assert.isBelow(pages, 70);
        const page = yield* historyPage(threadId, byteNext);
        assert.isAbove(page.items.length, 0);
        byteIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        byteNext = page.nextCursor;
      }
      assert.deepEqual(
        byteIds,
        Array.from({ length: 70 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      for (const ordinal of [1, 1_000]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-sql-history:message:${ordinal}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: MessageId.make(`message:bounded-sql-history:${ordinal}`),
            threadId,
            runId: RunId.make(`run:bounded-sql-history:${ordinal}`),
            nodeId: NodeId.make(`node:bounded-sql-history:${ordinal}`),
            role: "user",
            text: `Turn ${ordinal}`,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      // Selected message reads recover ordinals for only the loaded messages, while 69
      // unloaded assistant messages remain in the thread's history.
      const firstMessageId = MessageId.make("message:bounded-sql-history:1");
      const lastMessageId = MessageId.make("message:bounded-sql-history:1000");
      const insertMessageItem = (
        suffix: string,
        itemThreadId: string,
        ordinal: number,
        messageId: string | null | undefined,
      ) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${`turn-item:bounded-sql-history:ordinal-${suffix}`}, ${itemThreadId}, NULL, NULL, NULL,
          NULL, NULL, ${ordinal}, 'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({ messageId })}
        )
      `;
      yield* insertMessageItem("duplicate", threadId, 0, lastMessageId);
      yield* insertMessageItem(
        "other-thread",
        "thread:bounded-sql-history:other",
        -1,
        firstMessageId,
      );
      yield* insertMessageItem("null-id", threadId, -2, null);
      yield* insertMessageItem("missing-id", threadId, -3, undefined);
      const readMessageIds = (filter?: ProjectionStore.ProjectionRecordFilter) =>
        projectionStore
          .getThreadRecords(threadId, ["messages"], filter)
          .pipe(Effect.map(({ messages }) => messages.map((message) => message.id)));
      assert.deepEqual(yield* readMessageIds(), [lastMessageId, firstMessageId]);
      assert.deepEqual(yield* readMessageIds({ messageRoles: ["user", "assistant"] }), [
        lastMessageId,
        firstMessageId,
      ]);
      for (const filter of [
        {
          messageIds: [
            firstMessageId,
            lastMessageId,
            MessageId.make("message:bounded-sql-history:absent"),
          ],
        },
        { messageRoles: ["user" as const] },
        {
          messageRunIds: [
            RunId.make("run:bounded-sql-history:1"),
            RunId.make("run:bounded-sql-history:1000"),
          ],
        },
      ]) {
        assert.deepEqual(yield* readMessageIds(filter), [lastMessageId, firstMessageId]);
      }
      assert.deepEqual(yield* readMessageIds({ messageIds: [] }), []);
      assert.deepEqual(yield* readMessageIds({ messageIds: [firstMessageId] }), [firstMessageId]);
      // User-only reads must stay on the partial index instead of scanning every turn item.
      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
        .pipe(Effect.withTracer(tracer));
      const ordinalLookup = statements.find((statement) => statement.includes("MIN(ordinal)"));
      assert.isDefined(ordinalLookup);
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${ordinalLookup}`,
        [threadId, "[]"],
      )).map((row) => row.detail);
      assert.isTrue(
        plan.some((detail) => detail.includes("turn_items_user_message_idx")),
        plan.join("\n"),
      );
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id LIKE 'turn-item:bounded-sql-history:ordinal-%'
      `;

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 2 AND 70
      `;

      // Byte bounds must not cut off a target beyond 20 human turns.
      yield* setTurnType("user_message", 600, 624);
      const targetedPage = yield* historyPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:625"),
          position: 624,
        }),
        "turn-item:bounded-sql-history:600",
      );
      assert.strictEqual(
        String(targetedPage.items[0]?.sourceItemId),
        "turn-item:bounded-sql-history:600",
      );
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 600 AND 624
      `;

      // A turn split by the row budget keeps an interrupt result's request on the same page.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:500',
          type = CASE ordinal WHEN 500 THEN 'run_interrupt_request' ELSE 'run_interrupt_result' END,
          payload_json = json_set(payload_json,
            '$.runId', 'run:bounded-sql-history:500', '$.message', 'Stop',
            '$.type', CASE ordinal WHEN 500 THEN 'run_interrupt_request' ELSE 'run_interrupt_result' END)
        WHERE thread_id = ${threadId} AND ordinal IN (500, 580)
      `;
      const interruptPage = yield* historyPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:590"),
          position: 589,
        }),
      );
      const interruptIds = interruptPage.items.map((row) => String(row.sourceItemId));
      assert.include(interruptIds, "turn-item:bounded-sql-history:580");
      assert.include(interruptIds, "turn-item:bounded-sql-history:500");
      assert.notInclude(interruptIds, "turn-item:bounded-sql-history:501");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:' || ordinal, type = 'command_execution',
          payload_json = json_set(payload_json,
            '$.runId', 'run:bounded-sql-history:' || ordinal, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal IN (500, 580)
      `;

      const retainedRequestPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH selected AS (
          SELECT run_id, type
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC
          LIMIT 77
        )
        SELECT request.payload_json
        FROM orchestration_v2_projection_turn_items AS request
        WHERE request.run_id IN (
            SELECT run_id FROM selected
            WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
          )
          AND request.type = 'run_interrupt_request'
      `;
      assert.isTrue(
        retainedRequestPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_run_ordinal_idx"),
        ),
      );

      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 76,
        anchorItemId: TurnItemId.make("turn-item:bounded-sql-history:925"),
      });
      assert.lengthOf(older.projection.turnItems, 76);
      assert.lengthOf(older.projection.runs, 76);
      assert.strictEqual(older.projection.turnItems[0]?.ordinal, 850);
      assert.strictEqual(older.projection.turnItems.at(-1)?.ordinal, 925);

      const itemId = TurnItemId.make("turn-item:bounded-sql-history:925");
      const stored = yield* projectionStore.getTurnItem({ threadId, itemId });
      assert.strictEqual(stored?.type === "command_execution" ? stored.output : undefined, "ok");
      assert.isNull(
        yield* projectionStore.getTurnItem({ threadId: ThreadId.make("thread:other"), itemId }),
      );

      const sqlPageLimit = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
      const initialSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      const initialPage = buildBoundedThreadProjection({
        projection: initialSnapshot.projection,
        snapshotSequence: initialSnapshot.snapshotSequence,
      });
      const loadedIds = initialPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let cursor = initialPage.historyCursor;
      let pageCount = 1;
      while (cursor !== null) {
        const anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(cursor).si);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 20,
          anchorItemId,
        });
        assert.isAtMost(
          snapshot.projection.visibleTurnItems.length,
          THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
        );
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        loadedIds.push(...page.items.map((row) => String(row.sourceItemId)));
        pageCount += 1;
        cursor = page.nextCursor;
      }

      assert.isAtLeast(pageCount, 3);
      assert.lengthOf(loadedIds, 1_000);
      assert.strictEqual(new Set(loadedIds).size, 1_000);
      assert.deepEqual(
        loadedIds.toSorted(
          (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
        ),
        Array.from({ length: 1_000 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      yield* setTurnType("command_execution", 1000);
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:1',
          payload_json = json_set(payload_json, '$.runId', 'run:bounded-sql-history:1')
        WHERE thread_id = ${threadId}
      `;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET ordinal = 1000,
        payload_json = json_set(payload_json, '$.ordinal', 1000)
        WHERE thread_id = ${threadId} AND ordinal = 999`;
      const promptId = TurnItemId.make("turn-item:bounded-sql-history:1");
      const { statements: deferredStatements, tracer: deferredTracer } = traceSqlStatements();
      const deferred = yield* projectionStore
        .getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        })
        .pipe(Effect.withTracer(deferredTracer));
      const deferredQuery = deferredStatements.find((statement) =>
        statement.includes("blocked_runs AS MATERIALIZED"),
      );
      assert.isDefined(deferredQuery);
      const deferredPlan = yield* sql.unsafe<{
        readonly id: number;
        readonly parent: number;
        readonly detail: string;
      }>(`EXPLAIN QUERY PLAN ${deferredQuery}`);
      const blockedRunsPlan = deferredPlan.find((row) => row.detail === "MATERIALIZE blocked_runs");
      assert.isDefined(blockedRunsPlan);
      const blockedLookup = deferredPlan.find(
        (row) => row.parent === blockedRunsPlan!.id && row.detail.startsWith("SEARCH "),
      );
      assert.include(blockedLookup?.detail ?? "", "run_id=?");
      assert.lengthOf(deferred.projection.visibleTurnItems, 2);
      assert.strictEqual(deferred.projection.visibleTurnItems[0]?.sourceItemId, promptId);
      const anchor = deferred.projection.visibleTurnItems[1]!;
      assert.strictEqual(anchor.item.deferredWork?.itemCount, 999);
      const workIds = new Set<TurnItemId>();
      let workCursor: string | null = anchor.item.deferredWork!.cursor;
      for (let pages = 0; workCursor !== null; pages += 1) {
        assert.isBelow(pages, 20);
        const page: OrchestrationV2ThreadHistoryPage = yield* historyPage(
          threadId,
          workCursor,
          anchor.sourceItemId,
          false,
          "work",
        );
        assert.isAtMost(page.items.length, 75);
        for (const row of page.items) workIds.add(row.sourceItemId);
        workCursor = page.nextCursor;
      }
      assert.strictEqual(workIds.size, 999);
      for (const toolName of ["goat.delegate_task", "mcp__goat__delegate_task"]) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool',
          payload_json = json_set(payload_json, '$.type', 'dynamic_tool', '$.toolName', ${toolName})
          WHERE thread_id = ${threadId} AND ordinal = 2`;
        const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        });
        assert.isUndefined(
          window.projection.visibleTurnItems.find((row) => row.item.ordinal === 2)?.item
            .deferredWork,
        );
        assert.strictEqual(
          window.projection.visibleTurnItems.find((row) => row.item.deferredWork)?.item.ordinal,
          3,
        );
        const pageRead = traceSqlStatements();
        const page = yield* historyPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId: "turn-item:bounded-sql-history:1000",
            position: 1000,
          }),
          undefined,
          false,
          "deferred",
        ).pipe(Effect.withTracer(pageRead.tracer));
        assert.isUndefined(page.items.find((row) => row.item.ordinal === 2)?.item.deferredWork);
        // Tool payloads hold megabytes, so a page looks for inline output only in its own runs.
        const payloadScans = pageRead.statements.filter((statement) =>
          statement.includes("LIKE '%htmlRender%'"),
        );
        assert.lengthOf(payloadScans, 1);
        assert.include(payloadScans[0], "item.run_id IS json_extract(wanted.value, '$.id')");
      }
      // Until its run is scanned, a cursor on inline output is hidden inside a work group.
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool',
        payload_json = json_set(payload_json, '$.type', 'dynamic_tool', '$.toolName', 't3-code.delegate_task')
        WHERE thread_id = ${threadId} AND ordinal = 4`;
      const sharedRunId = "run:bounded-sql-history:1";
      // A work page of rows that have no run leaves their inline output out too.
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = NULL
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 3 AND 6`;
      const runlessWork = yield* historyPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: "turn-item:bounded-sql-history:6",
          position: 6,
          inclusive: true,
        }),
        "turn-item:bounded-sql-history:3",
        false,
        "work",
      );
      assert.deepEqual(
        runlessWork.items.map((row) => row.item.ordinal),
        [3, 5, 6],
      );
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = ${sharedRunId}
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 3 AND 6`;
      // A stale position selects from the cursor row itself, or from more than a page after it
      // once the later rows are another run's and cannot fold.
      for (const [position, laterStatus, laterRun] of [
        [0, "completed", sharedRunId],
        [999, "running", "run:bounded-sql-history:300"],
      ] as const) {
        yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = ${laterStatus},
          run_id = ${laterRun},
          payload_json = json_set(payload_json, '$.status', ${laterStatus}, '$.runId', ${laterRun})
          WHERE thread_id = ${threadId} AND ordinal >= 300`;
        const beforeInlineOutput = yield* historyPage(
          threadId,
          encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: threadId,
            sourceItemId: "turn-item:bounded-sql-history:4",
            position,
          }),
          undefined,
          false,
          "deferred",
        );
        assert.deepEqual(
          beforeInlineOutput.items.map((row) => row.item.ordinal),
          [1, 2, 3],
        );
      }
      // A cursor whose row is gone falls back to its position. Inline output between the page
      // and that position can belong to a run with no other row there.
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET status = CASE WHEN ordinal <= 700 THEN 'running' ELSE 'completed' END,
          run_id = CASE WHEN ordinal <= 700 THEN 'run:bounded-sql-history:300' ELSE ${sharedRunId} END,
          payload_json = json_set(payload_json,
            '$.status', CASE WHEN ordinal <= 700 THEN 'running' ELSE 'completed' END,
            '$.runId', CASE WHEN ordinal <= 700 THEN 'run:bounded-sql-history:300' ELSE ${sharedRunId} END)
        WHERE thread_id = ${threadId} AND ordinal >= 100`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'dynamic_tool',
        payload_json = json_set(payload_json, '$.type', 'dynamic_tool', '$.toolName', 't3-code.delegate_task')
        WHERE thread_id = ${threadId} AND ordinal = 720`;
      const beforeMissingCursor = yield* historyPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: "turn-item:bounded-sql-history:gone",
          position: 800,
        }),
        undefined,
        false,
        "deferred",
      );
      assert.strictEqual(beforeMissingCursor.items.at(-1)?.item.ordinal, 720);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET status = 'completed',
        run_id = ${sharedRunId},
        payload_json = json_set(payload_json, '$.status', 'completed', '$.runId', ${sharedRunId})
        WHERE thread_id = ${threadId} AND ordinal >= 100`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'command_execution',
        payload_json = json_set(payload_json, '$.type', 'command_execution') WHERE thread_id = ${threadId} AND ordinal IN (2, 4, 720)`;
      for (const [ordinal, status] of [
        [0, "completed"],
        [1, "superseded"],
        [2, "running"],
      ] as const) {
        const attempt = {
          id: `attempt:bounded-sql-history:${ordinal}`,
          runId: sharedRunId,
          attemptOrdinal: ordinal + 1,
          rootNodeId: `node:bounded-sql-history:attempt-${ordinal === 0 ? 1 : ordinal}`,
          providerInstanceId,
          providerThreadId: "provider-thread:bounded-sql-history",
          providerTurnId: null,
          reason: ordinal === 1 ? "initial" : "steering_restart",
          status,
          startedAt: nowIso,
          completedAt: status === "superseded" ? nowIso : null,
        };
        yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
          (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json)
          VALUES (${attempt.id}, ${threadId}, ${sharedRunId}, ${attempt.attemptOrdinal}, ${attempt.rootNodeId}, ${providerInstanceId}, ${providerInstanceId}, ${attempt.providerThreadId}, NULL, ${status}, ${encodeUnknownJsonString(attempt)})`;
      }
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET node_id = CASE WHEN ordinal < 990 AND ordinal <> 10 THEN 'node:bounded-sql-history:attempt-1' ELSE 'node:bounded-sql-history:attempt-2' END,
          payload_json = json_set(payload_json, '$.nodeId', CASE WHEN ordinal < 990 AND ordinal <> 10 THEN 'node:bounded-sql-history:attempt-1' ELSE 'node:bounded-sql-history:attempt-2' END)
        WHERE thread_id = ${threadId}`;
      for (const status of ["completed", "running"]) {
        yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status},
          payload_json = json_set(payload_json, '$.status', ${status}) WHERE run_id = ${sharedRunId}`;
        const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        });
        const oldWork = window.projection.visibleTurnItems.find((row) => row.item.deferredWork);
        assert.strictEqual(oldWork?.item.deferredWork?.itemCount, 987);
        let cursor: string | null = oldWork!.item.deferredWork!.cursor;
        const loaded = new Set<TurnItemId>();
        for (let pages = 0; cursor !== null; pages += 1) {
          assert.isBelow(pages, 20);
          const page: OrchestrationV2ThreadHistoryPage = yield* historyPage(
            threadId,
            cursor,
            oldWork!.sourceItemId,
            false,
            "work",
          );
          for (const row of page.items) loaded.add(row.sourceItemId);
          cursor = page.nextCursor;
        }
        assert.strictEqual(loaded.size, 987);
        assert.isFalse(loaded.has(TurnItemId.make("turn-item:bounded-sql-history:10")));
      }
      yield* sql`DELETE FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed',
        payload_json = json_set(payload_json, '$.status', 'completed') WHERE run_id = ${sharedRunId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET node_id = NULL,
        payload_json = json_set(payload_json, '$.nodeId', NULL) WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = NULL,
        payload_json = json_set(payload_json, '$.runId', NULL)
        WHERE thread_id = ${threadId} AND ordinal > 1 AND ordinal < 851`;
      const inlineWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.isFalse(inlineWindow.projection.visibleTurnItems.some((row) => row.item.deferredWork));
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = ${sharedRunId},
        payload_json = json_set(payload_json, '$.runId', ${sharedRunId})
        WHERE thread_id = ${threadId} AND ordinal = 850`;
      const deferredWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.isTrue(
        deferredWindow.projection.visibleTurnItems.some(
          (row) => row.item.deferredWork?.itemCount === 151,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:1',
          payload_json = json_set(payload_json, '$.runId', 'run:bounded-sql-history:1')
        WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET ordinal = 999,
        payload_json = json_set(payload_json, '$.ordinal', 999)
        WHERE turn_item_id = 'turn-item:bounded-sql-history:999'`;
      // Work folded below the newest 502 visible rows still counts its whole group, so the
      // 100 commands after the messages stay hidden in the 398-item group.
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'assistant_message',
        payload_json = json_set(payload_json, '$.type', 'assistant_message', '$.text', 'Working',
          '$.messageId', turn_item_id, '$.streaming', json('false'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 300 AND 899`;
      const straddledWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      const straddledOrdinals = [
        ...Array.from({ length: sqlPageLimit }, (_, index) => 900 - sqlPageLimit + index),
        1000,
      ];
      assert.deepEqual(
        straddledWindow.projection.turnItems.map((item) => item.ordinal),
        straddledOrdinals,
      );
      // A run that starts with work (a wake) has no segment start, so the group begins at its first item.
      const moveFirstItemToRun = (runId: string) => sql`
        UPDATE orchestration_v2_projection_turn_items SET run_id = ${runId},
          payload_json = json_set(payload_json, '$.runId', ${runId})
        WHERE thread_id = ${threadId} AND ordinal = 1`;
      yield* moveFirstItemToRun("run:bounded-sql-history:2");
      const wakeWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.deepEqual(
        wakeWindow.projection.turnItems.map((item) => item.ordinal),
        straddledOrdinals,
      );
      yield* moveFirstItemToRun(sharedRunId);
      // A failed error below the tail still blocks folding for its run. Only the SQL columns
      // change; the row sits below the window, so its payload is never decoded.
      // A steer at 100 starts a later segment, so the error sits below the scan start too.
      const setItem = (ordinal: number, type: string, status: string) => sql`
        UPDATE orchestration_v2_projection_turn_items SET type = ${type}, status = ${status}
        WHERE thread_id = ${threadId} AND ordinal = ${ordinal}`;
      yield* setItem(100, "user_message", "completed");
      yield* setItem(2, "error", "failed");
      const blockedWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.isFalse(
        blockedWindow.projection.visibleTurnItems.some((row) => row.item.deferredWork),
      );
      assert.deepEqual(
        blockedWindow.projection.turnItems.map((item) => item.ordinal),
        Array.from({ length: sqlPageLimit }, (_, index) => 1001 - sqlPageLimit + index),
      );
      yield* setItem(2, "command_execution", "completed");
      yield* setItem(100, "command_execution", "completed");
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET type = 'command_execution',
        payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 300 AND 899`;

      // Runless rows below a run that starts after the newest 502 visible rows stay in the window.
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET run_id = CASE WHEN ordinal > 990 THEN 'run:bounded-sql-history:991' END,
          type = CASE WHEN ordinal = 991 THEN 'user_message' ELSE 'assistant_message' END,
          payload_json = CASE WHEN ordinal = 991
            THEN json_set(payload_json, '$.type', 'user_message', '$.runId', 'run:bounded-sql-history:991',
              '$.createdBy', 'user', '$.creationSource', 'web', '$.inputIntent', 'turn_start',
              '$.messageId', turn_item_id, '$.text', 'Turn 991', '$.attachments', json('[]'))
            ELSE json_set(payload_json, '$.type', 'assistant_message',
              '$.runId', CASE WHEN ordinal > 990 THEN 'run:bounded-sql-history:991' END,
              '$.text', 'Working', '$.messageId', turn_item_id, '$.streaming', json('false'))
          END
        WHERE thread_id = ${threadId} AND ordinal > 1`;
      const windowStatements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const runlessWindow = yield* projectionStore
        .getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 10,
          deferWork: true,
        })
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            windowStatements.push(statement.compile());
            return Effect.succeed(statement);
          }),
        );
      // The window read must not grow with history below the newest visible rows. VM steps are
      // deterministic; reading the whole history here cost 65% more steps.
      const copyPath = "file:/thread-window-steps?vfs=memdb";
      {
        using copy = new NodeSqlite.DatabaseSync(copyPath);
        yield* sql`VACUUM INTO ${copyPath}`;
        assert.isNotEmpty(windowStatements);
        const windowSteps = () =>
          windowStatements.reduce((steps, [query, params]) => {
            const statement = copy.prepare(query);
            statement.all(...(params as ReadonlyArray<NodeSqlite.SQLInputValue>));
            return steps + statement.stat("vmStep");
          }, 0);
        const fullSteps = windowSteps();
        assert.isAbove(fullSteps, 0);
        copy.exec(
          "DELETE FROM orchestration_v2_projection_turn_items WHERE ordinal BETWEEN 2 AND 498",
        );
        assert.isAtMost(fullSteps, windowSteps() * 1.1);
      }
      assert.deepEqual(
        runlessWindow.projection.turnItems.map((item) => item.ordinal),
        Array.from({ length: THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT }, (_, index) => 499 + index),
      );
      const runlessPage = buildBoundedThreadProjection({
        projection: runlessWindow.projection,
        snapshotSequence: runlessWindow.snapshotSequence,
      });
      assert.isTrue(runlessPage.hasMoreHistory);
      assert.isNotNull(runlessPage.historyCursor);
      // Limits SQLite reads differently from `tailRows` skip the tail bound and match main.
      const windowOrdinalCount = (rowLimit: number) =>
        projectionStore
          .getThreadSnapshotWindow(threadId, { rowLimit, userTurnLimit: 10, deferWork: true })
          .pipe(Effect.map((window) => window.projection.turnItems.length));
      assert.strictEqual(yield* windowOrdinalCount(502.5), THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT);
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.inputIntent', 'steer')
        WHERE thread_id = ${threadId} AND ordinal = 991`;
      assert.strictEqual(yield* windowOrdinalCount(-1), 1000);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET run_id = ${sharedRunId},
        type = 'command_execution',
        payload_json = json_set(payload_json, '$.type', 'command_execution', '$.runId', ${sharedRunId})
        WHERE thread_id = ${threadId} AND ordinal > 1`;
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal = 1
      `;
      const backgroundWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: 10,
        deferWork: true,
      });
      assert.lengthOf(backgroundWindow.projection.visibleTurnItems, sqlPageLimit);
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message', payload_json = json_set(payload_json, '$.type', 'user_message')
        WHERE thread_id = ${threadId} AND ordinal = 1
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:' || ordinal,
          payload_json = json_set(payload_json, '$.runId', 'run:bounded-sql-history:' || ordinal)
        WHERE thread_id = ${threadId}
      `;
      yield* setTurnType("user_message", 1000);

      const tiedIds = [
        TurnItemId.make("turn-item:bounded-sql-history:tie:b"),
        TurnItemId.make("turn-item:bounded-sql-history:tie:a"),
      ];
      for (const id of tiedIds) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT ${id}, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, 2000, type, status, updated_at,
            json_set(payload_json, '$.id', ${id}, '$.ordinal', 2000)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `;
      }
      const tied = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 3 });
      assert.deepEqual(
        tied.projection.turnItems.map((item) => item.id),
        [TurnItemId.make("turn-item:bounded-sql-history:1000"), tiedIds[1], tiedIds[0]],
      );
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(tiedIds)}
      `;

      const hiddenRunId = RunId.make("run:bounded-sql-history:hidden-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${hiddenRunId}, ${threadId}, 1001, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: hiddenRunId,
            threadId,
            ordinal: 1001,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:hidden-suffix",
            rootNodeId: "node:bounded-sql-history:hidden-suffix",
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_001; ordinal <= 1_100; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:hidden:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${hiddenRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: hiddenRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "rolled back",
              input: "echo hidden",
              output: "hidden",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const hiddenSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const hiddenSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: hiddenSuffixSnapshot.projection,
        snapshotSequence: hiddenSuffixSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixPage.projection.visibleTurnItems, 75);
      assert.strictEqual(hiddenSuffixPage.latestLocalTurnOrdinal, 1_100);
      assert.isTrue(hiddenSuffixPage.hasMoreHistory);
      assert.isFalse(
        hiddenSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":hidden:"),
        ),
      );
      const hiddenSuffixCursor = hiddenSuffixPage.historyCursor;
      assert.isNotNull(hiddenSuffixCursor);
      const hiddenSuffixAnchor = TurnItemId.make(decodeThreadHistoryCursor(hiddenSuffixCursor!).si);
      const hiddenSuffixOlderSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        anchorItemId: hiddenSuffixAnchor,
      });
      const hiddenSuffixOlderPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: hiddenSuffixOlderSnapshot.projection.visibleTurnItems,
        cursor: hiddenSuffixCursor!,
        snapshotSequence: hiddenSuffixOlderSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixOlderPage.items, 75);
      assert.isTrue(hiddenSuffixOlderPage.hasMoreHistory);

      const cancelledRunId = RunId.make("run:bounded-sql-history:cancelled-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${cancelledRunId}, ${threadId}, 1002, 'codex', NULL, 'cancelled', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: cancelledRunId,
            threadId,
            ordinal: 1002,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:cancelled-suffix",
            rootNodeId: "node:bounded-sql-history:cancelled-suffix",
            activeAttemptId: null,
            status: "cancelled",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_101; ordinal <= 1_200; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:cancelled:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'user_message', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              createdBy: "user",
              creationSource: "web",
              id,
              threadId,
              runId: cancelledRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "cancelled queued message",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "user_message",
              messageId: `message:bounded-sql-history:cancelled:${ordinal}`,
              inputIntent: "queued_turn",
              text: "cancelled",
              attachments: [],
            })}
          )
        `;
      }
      const runlessQueuedId = "turn-item:bounded-sql-history:runless-queued";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${runlessQueuedId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1201,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: runlessQueuedId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1201,
            status: "completed",
            title: "runless queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:runless-queued",
            inputIntent: "queued_turn",
            text: "still visible",
            attachments: [],
          })}
        )
      `;
      const laterCancelledId = "turn-item:bounded-sql-history:cancelled:1202";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${laterCancelledId}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, 1202,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: laterCancelledId,
            threadId,
            runId: cancelledRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1202,
            status: "completed",
            title: "later cancelled queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:cancelled:1202",
            inputIntent: "queued_turn",
            text: "cancelled",
            attachments: [],
          })}
        )
      `;
      const cancelledSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const cancelledSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: cancelledSuffixSnapshot.projection,
        snapshotSequence: cancelledSuffixSnapshot.snapshotSequence,
      });
      assert.strictEqual(cancelledSuffixPage.latestLocalTurnOrdinal, 1_202);
      assert.lengthOf(cancelledSuffixPage.projection.visibleTurnItems, 75);
      assert.isFalse(
        cancelledSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":cancelled:"),
        ),
      );
      assert.isTrue(
        cancelledSuffixPage.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === runlessQueuedId,
        ),
      );

      const interruptRunId = RunId.make("run:bounded-sql-history:interrupt");
      const interruptNodeId = NodeId.make("node:bounded-sql-history:interrupt");
      const interruptRequestId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-request");
      const interruptResultId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-result");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${interruptRunId}, ${threadId}, 1003, 'codex', 'provider-thread:interrupt', 'completed',
          ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: interruptRunId,
            threadId,
            ordinal: 1003,
            providerInstanceId,
            modelSelection,
            providerThreadId: "provider-thread:interrupt",
            userMessageId: "message:interrupt",
            rootNodeId: interruptNodeId,
            activeAttemptId: "attempt:bounded-sql-history:interrupt",
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:bounded-sql-history:interrupt', ${threadId}, ${interruptRunId}, 1,
          ${interruptNodeId}, 'codex', ${providerInstanceId}, 'provider-thread:interrupt', NULL,
          'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:bounded-sql-history:interrupt",
            runId: interruptRunId,
            attemptOrdinal: 1,
            rootNodeId: interruptNodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:interrupt",
            providerTurnId: null,
            reason: "initial",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      const insertInterruptItem = (input: {
        id: TurnItemId;
        ordinal: number;
        type: "run_interrupt_request" | "run_interrupt_result";
      }) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${input.id}, ${threadId}, ${interruptRunId}, ${interruptNodeId}, NULL, NULL, NULL,
          ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: input.id,
            threadId,
            runId: interruptRunId,
            nodeId: interruptNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal,
            status: "completed",
            title: input.type,
            message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: input.type,
          })}
        )
      `;
      yield* insertInterruptItem({
        id: interruptRequestId,
        ordinal: 1_201,
        type: "run_interrupt_request",
      });
      for (let ordinal = 1_202; ordinal <= 1_281; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:interrupt-filler:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "filler",
              input: "echo filler",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      yield* insertInterruptItem({
        id: interruptResultId,
        ordinal: 1_282,
        type: "run_interrupt_result",
      });

      const interruptSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      assert.isTrue(
        interruptSnapshot.projection.turnItems.some((item) => item.id === interruptRequestId),
      );
      assert.isTrue(
        interruptSnapshot.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === interruptResultId,
        ),
      );

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.createdBy', 'agent')
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      const agentPromptId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-filler:1281");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message',
          payload_json = json_set(payload_json,
            '$.type', 'user_message', '$.inputIntent', 'turn_start',
            '$.createdBy', 'agent', '$.creationSource', 'provider',
            '$.messageId', 'message:bounded-sql-history:agent-prompt',
            '$.text', 'Continue the child task', '$.attachments', json('[]'))
        WHERE turn_item_id = ${agentPromptId}
      `;
      const agentWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      assert.lengthOf(
        agentWindow.projection.visibleTurnItems.filter(
          (row) => row.item.type !== "run_interrupt_request",
        ),
        sqlPageLimit,
      );
      assert.isTrue(
        agentWindow.projection.visibleTurnItems.some((row) => row.sourceItemId === agentPromptId),
      );
    }),
  );

  it.effect("pages a whole thread without re-reading its full timeline for every page", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:paged-scrollback");
      const runId = RunId.make("run:paged-scrollback");
      const itemCount = 600;
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:paged-scrollback"),
          title: "Paged scrollback",
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
        },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${runId}, ${threadId}, 1, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:paged-scrollback",
            rootNodeId: "node:paged-scrollback",
            activeAttemptId: null,
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 0; ordinal < itemCount; ordinal += 1) {
        const id = `turn-item:paged-scrollback:${ordinal}`;
        const message = ordinal % 9 === 0;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            ${message ? "user_message" : "command_execution"}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `item ${ordinal}`,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              ...(message
                ? {
                    type: "user_message",
                    createdBy: "user",
                    creationSource: "web",
                    messageId: `message:paged-scrollback:${ordinal}`,
                    inputIntent: "turn_start",
                    text: `Turn ${ordinal}`,
                    attachments: [],
                  }
                : { type: "command_execution", input: "echo", output: "ok", exitCode: 0 }),
            })}
          )
        `;
      }
      // An unbounded read of every turn item in the thread costs O(thread) per page, so a full
      // scrollback that repeats it on each page is quadratic in thread length.
      const wholeThreadReads = (statements: ReadonlyArray<string>) =>
        statements.filter(
          (statement) =>
            /FROM orchestration_v2_projection_turn_items(\s+AS item)?\s+WHERE (item\.)?thread_id = \?\s*(ORDER BY|$)/.test(
              statement,
            ) && !/\bLIMIT\b/.test(statement),
        ).length;
      const snapshot = yield* projectionStore.getThreadSnapshot(threadId);

      const history = traceSqlStatements();
      let cursor: string | null = encodeThreadHistoryCursor({
        snapshotSequence: snapshot.snapshotSequence,
        sourceThreadId: threadId,
        sourceItemId: "absent",
        position: itemCount,
      });
      const historyIds: Array<string> = [];
      let historyPages = 0;
      while (cursor !== null) {
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore
          .getThreadHistoryPage(threadId, cursor)
          .pipe(Effect.withTracer(history.tracer));
        historyIds.push(...page.items.map((row) => String(row.sourceItemId)));
        historyPages += 1;
        cursor = page.hasMoreHistory ? page.nextCursor : null;
      }
      assert.strictEqual(new Set(historyIds).size, itemCount);
      assert.isAtLeast(historyPages, 4);

      const timeline = traceSqlStatements();
      const timelineIds: Array<string> = [];
      let afterPosition = -1;
      let timelinePages = 0;
      for (let hasMore = true; hasMore;) {
        const page = yield* projectionStore
          .getTimelinePage(threadId, { view: "activity", afterPosition, limit: 100 })
          .pipe(Effect.withTracer(timeline.tracer));
        timelineIds.push(...page.items.map((row) => String(row.sourceItemId)));
        afterPosition = page.items.at(-1)?.position ?? afterPosition;
        timelinePages += 1;
        hasMore = page.hasMore;
      }
      assert.strictEqual(new Set(timelineIds).size, itemCount);
      assert.isAtLeast(timelinePages, 4);

      assert.isAtMost(
        wholeThreadReads(history.statements),
        1,
        `getThreadHistoryPage read the whole thread on each of ${historyPages} pages`,
      );
      assert.isAtMost(
        wholeThreadReads(timeline.statements),
        1,
        `getTimelinePage read the whole thread on each of ${timelinePages} pages`,
      );

      // A write to the thread a fork inherits from must reach the fork's next page.
      const forkThreadId = ThreadId.make("thread:paged-scrollback:fork");
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:fork"),
        type: "thread.created",
        threadId: forkThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: forkThreadId,
          projectId: ProjectId.make("project:paged-scrollback"),
          title: "Paged scrollback fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: threadId,
            relationshipToParent: "fork",
            rootThreadId: threadId,
          },
          forkedFrom: { type: "run", threadId, runId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const forkPage = () =>
        projectionStore.getTimelinePage(forkThreadId, { view: "activity", limit: 1 });
      const forkTotal = (yield* forkPage()).totalItems;
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal);
      yield* projectionStore.apply({
        id: EventId.make("event:paged-scrollback:late-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:paged-scrollback:late"),
          threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: itemCount,
          status: "completed",
          title: "late",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "command_execution",
          input: "echo",
        },
      });
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal + 1);

      // Another store instance's write reaches this one only through the committed thread event.
      const directId = "turn-item:paged-scrollback:direct";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${directId}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${itemCount + 1},
          'command_execution', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: directId,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: itemCount + 1,
            status: "completed",
            title: "direct",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "command_execution",
            input: "echo",
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:paged-scrollback:direct', 'thread', ${threadId}, 1,
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )
      `;
      assert.strictEqual((yield* forkPage()).totalItems, forkTotal + 2);

      // An agent started this thread, so the snapshot folds no work. Its cursor then names a
      // command that an older page folds into the run's one work group.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = CASE WHEN ordinal = 0 THEN type ELSE 'assistant_message' END,
          payload_json = CASE
            WHEN ordinal = 0 THEN json_set(payload_json, '$.createdBy', 'agent')
            ELSE json_set(payload_json, '$.type', 'assistant_message',
              '$.messageId', turn_item_id, '$.streaming', json('false'))
          END
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          'event:paged-scrollback:agent-started', 'thread', ${threadId}, 2,
          'turn-item.updated', ${nowIso}, 'user', '{}', '{}', 2
        )
      `;
      const window = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        deferWork: true,
      });
      const bounded = buildBoundedThreadProjection({
        projection: window.projection,
        snapshotSequence: window.snapshotSequence,
      });
      const loaded = [bounded.projection.visibleTurnItems];
      let earlier = bounded.hasMoreHistory ? bounded.historyCursor : null;
      while (earlier !== null) {
        assert.isBelow(loaded.length, 20);
        const page: OrchestrationV2ThreadHistoryPage = yield* projectionStore.getThreadHistoryPage(
          threadId,
          earlier,
          undefined,
          false,
          "deferred",
        );
        loaded.unshift(page.items);
        earlier = page.hasMoreHistory ? page.nextCursor : null;
      }
      const held = loaded.flat();
      const heldOrdinals = held.map((row) => row.item.ordinal);
      assert.deepEqual(
        heldOrdinals,
        [...new Set(heldOrdinals)].toSorted((left, right) => left - right),
      );
      const folded = held.find((row) => row.item.deferredWork !== undefined)?.item;
      assert.isAbove(folded?.deferredWork?.itemCount ?? 0, 150);
      const everyRow = yield* projectionStore.getTimelinePage(threadId, {
        view: "activity",
        limit: itemCount + 2,
      });
      // Every row is on the client, or is work that the folded row stands for.
      assert.deepEqual(
        everyRow.items
          .filter(
            ({ item }) =>
              !heldOrdinals.includes(item.ordinal) &&
              !(
                item.type === "command_execution" &&
                folded?.deferredWork !== undefined &&
                item.ordinal > folded.ordinal &&
                item.ordinal <= folded.deferredWork.lastOrdinal
              ),
          )
          .map(({ item }) => item.ordinal),
        [],
      );
    }),
  );

  it.effect("scopes actionable provider state to the requested bounded thread", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:bounded-provider-scope");
      const targetThreadId = ThreadId.make("thread:bounded-provider-scope:target");
      const unrelatedThreadId = ThreadId.make("thread:bounded-provider-scope:unrelated");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: String(threadId),
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
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
      });
      for (const threadId of [targetThreadId, unrelatedThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:thread:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
        const sessionId = ProviderSessionId.make(`provider-session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:session:${threadId}`),
          type: "provider-session.attached",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });

      assert.deepEqual(
        snapshot.projection.providerSessions.map((session) => session.id),
        [ProviderSessionId.make(`provider-session:${targetThreadId}`)],
      );
      assert.deepEqual(
        snapshot.projection.providerThreads.map((thread) => thread.id),
        [ProviderThreadId.make(`provider-thread:${targetThreadId}`)],
      );
    }),
  );

  it.effect("projects root provider owners into the shell in first-use order", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:provider-history");
      const threadId = ThreadId.make("thread:provider-history");
      const claudeInstanceId = ProviderInstanceId.make("claude");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Provider history",
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
        },
      });
      const providerThreads = [
        { suffix: "codex", instanceId: providerInstanceId, ownerNodeId: null, seconds: 0 },
        {
          suffix: "claude-subagent",
          instanceId: claudeInstanceId,
          ownerNodeId: NodeId.make("node:provider-history"),
          seconds: 1,
        },
        { suffix: "claude", instanceId: claudeInstanceId, ownerNodeId: null, seconds: 2 },
        { suffix: "codex-again", instanceId: providerInstanceId, ownerNodeId: null, seconds: 3 },
      ] as const;
      for (const providerThread of providerThreads) {
        const createdAt = DateTime.add(now, { seconds: providerThread.seconds });
        yield* projectionStore.apply({
          id: EventId.make(`event:provider-history:${providerThread.suffix}`),
          type: "provider-thread.updated",
          threadId,
          driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
          occurredAt: createdAt,
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-history:${providerThread.suffix}`),
            driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
            providerInstanceId: providerThread.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: providerThread.ownerNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(shell?.providerInstanceHistory, [providerInstanceId, claudeInstanceId]);
    }),
  );

  it.effect("shows the native goal of the active provider thread on the shell", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-goal");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-goal:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-goal"),
          title: "Provider goal",
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
        },
      });
      const applyProviderThread = (
        suffix: string,
        goal: OrchestrationV2ProviderThread["goal"],
        seconds: number,
      ) =>
        projectionStore.apply({
          id: EventId.make(`event:provider-goal:${suffix}:${seconds}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: DateTime.add(now, { seconds }),
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-goal:${suffix}`),
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            goal,
            createdAt: now,
            updatedAt: DateTime.add(now, { seconds }),
          },
        });
      const shellGoal = Effect.map(
        projectionStore.getShellSnapshot(),
        (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)?.goal,
      );
      const goal = { objective: "Ship it", status: "active" as const, tokensUsed: 10 };

      yield* applyProviderThread("first", goal, 0);
      assert.deepEqual(yield* shellGoal, goal);
      yield* applyProviderThread("second", null, 1);
      assert.isNull(yield* shellGoal);
    }),
  );

  it.effect("reads the shell snapshot first and decodes it in a separate step", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const createThread = (threadId: ThreadId) =>
        projectionStore.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:shell-read"),
            title: "Shell read",
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
          },
        });
      const readThreadId = ThreadId.make("thread:shell-read:before");
      const laterThreadId = ThreadId.make("thread:shell-read:after");
      const shellIds = (snapshot: OrchestrationV2ThreadShellSnapshot) =>
        snapshot.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId);

      yield* createThread(readThreadId);
      const decode = yield* sql.withTransaction(projectionStore.readShellSnapshot());
      yield* createThread(laterThreadId);

      assert.deepEqual(shellIds(yield* decode), [readThreadId]);
      assert.sameMembers(shellIds(yield* projectionStore.getShellSnapshot()), [
        readThreadId,
        laterThreadId,
      ]);

      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${laterThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${laterThreadId}`;
      yield* setPayload("{}");
      const failure = yield* sql
        .withTransaction(projectionStore.readShellSnapshot())
        .pipe(
          Effect.flatMap(Effect.flip),
          Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect("reads only the requested project's threads into a scoped shell snapshot", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { projectId, activeThreadId, forkThreadId, otherThreadId } =
        yield* assertProjectScopedShells("sql-project-shell");

      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${otherThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${otherThreadId}`;
      yield* setPayload("{}");
      const [unscoped, scoped] = yield* Effect.all([
        projectionStore.getShellSnapshot().pipe(Effect.flip),
        projectionStore.getShellSnapshot({ projectId, location: "active" }),
      ]).pipe(Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))));
      assert.strictEqual(unscoped._tag, "ProjectionStoreReadError");
      assert.sameMembers(
        scoped.threads.map((thread) => thread.id),
        [activeThreadId, forkThreadId],
      );
    }),
  );

  it.effect("reads shell runs and item counts without walking a thread's history", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { projectId } = yield* assertProjectScopedShells("sql-shell-stop-index");
      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .getShellSnapshot({ projectId, location: "active" })
        .pipe(Effect.withTracer(tracer));
      const planOf = (statement: string) =>
        sql
          .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`)
          .pipe(Effect.map((rows) => rows.map((row) => row.detail)));

      const threadQuery = statements.find((statement) =>
        statement.includes("AS latest_run_stop_requested"),
      );
      assert.isDefined(threadQuery);
      const plan = yield* planOf(threadQuery);
      const stopRequestLookups = plan.filter((detail) => detail.startsWith("SEARCH stop_request "));
      assert.lengthOf(stopRequestLookups, 2);
      for (const lookup of stopRequestLookups) {
        assert.include(lookup, "orchestration_v2_projection_turn_items_stop_request_idx");
      }
      // The active, activity, and pending-secret lookups; walking the ordinal index instead
      // reads every run of an idle thread.
      const activeRunLookups = plan.filter(
        (detail) => detail.startsWith("SEARCH r ") && detail.includes("(thread_id=?"),
      );
      assert.lengthOf(activeRunLookups, 4);
      for (const lookup of activeRunLookups) {
        assert.include(lookup, "orchestration_v2_projection_runs_thread_status_idx");
      }
      const lastExecutedIndex = plan.findIndex((detail) =>
        detail.includes("orchestration_v2_projection_runs_last_executed_idx"),
      );
      assert.notStrictEqual(lastExecutedIndex, -1);
      // The lookup that follows the search is the sort it no longer needs.
      assert.notInclude(plan[lastExecutedIndex + 1] ?? "", "USE TEMP B-TREE");

      const countQueries = statements.filter((statement) => statement.includes("item_count"));
      assert.isNotEmpty(countQueries);
      for (const countQuery of countQueries) {
        for (const detail of yield* planOf(countQuery)) {
          assert.notInclude(detail, "orchestration_v2_projection_turn_items");
        }
      }
    }),
  );

  it.effect("reads a run's turn-start items by thread and run, not by walking thread history", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:turn-start-items");
      const otherThreadId = ThreadId.make("thread:turn-start-items:other");
      const selectedRunId = RunId.make("run:turn-start-items:selected");
      const emptyRunId = RunId.make("run:turn-start-items:empty");
      const siblingRunId = RunId.make("run:turn-start-items:sibling");

      for (const id of [threadId, otherThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:${id}:created`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id,
            projectId: ProjectId.make("project:turn-start-items"),
            title: id,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      }
      for (const [ordinal, runId] of [selectedRunId, emptyRunId, siblingRunId].entries()) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal + 1}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: ordinal + 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:${runId}`,
              rootNodeId: `node:${runId}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
      }

      const insertItem = (
        id: string,
        itemThreadId: ThreadId,
        runId: string | null,
        ordinal: number,
      ) =>
        sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${itemThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: itemThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: id,
              input: "echo",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      const addHistory = (from: number, to: number) => sql`
        WITH RECURSIVE history(position) AS (
          SELECT ${from} UNION ALL SELECT position + 1 FROM history WHERE position < ${to}
        )
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        )
        SELECT 'item:turn-start-items:history:' || position, ${threadId},
          'run:turn-start-items:history:' || (position % 100), NULL, NULL, NULL, NULL, position,
          'command_execution', 'completed', ${nowIso},
          json_object(
            'id', 'item:turn-start-items:history:' || position,
            'threadId', ${threadId},
            'runId', 'run:turn-start-items:history:' || (position % 100),
            'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL,
            'nativeItemRef', NULL, 'parentItemId', NULL, 'ordinal', position,
            'status', 'completed', 'title', 'history', 'input', 'echo', 'output', 'ok',
            'exitCode', 0, 'startedAt', ${nowIso}, 'completedAt', ${nowIso},
            'updatedAt', ${nowIso}, 'type', 'command_execution'
          )
        FROM history
      `;

      // Twelve ordinals with two items each, inserted in reverse id order.
      const selectedIds: Array<string> = [];
      for (let slot = 1; slot <= 12; slot += 1) {
        for (const suffix of ["b", "a"]) {
          yield* insertItem(
            `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:${suffix}`,
            threadId,
            selectedRunId,
            slot * 100,
          );
        }
        selectedIds.push(
          `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:a`,
          `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:b`,
        );
      }
      yield* insertItem("item:turn-start-items:no-run", threadId, null, 100);
      yield* insertItem("item:turn-start-items:sibling:1", threadId, siblingRunId, 100);
      yield* insertItem("item:turn-start-items:sibling:2", threadId, siblingRunId, 101);
      yield* insertItem("item:turn-start-items:other-thread:b", otherThreadId, selectedRunId, 100);
      yield* insertItem("item:turn-start-items:other-thread:a", otherThreadId, selectedRunId, 100);

      const readItems = Effect.fn("readTurnStartItems")(function* (
        readThreadId: ThreadId,
        readRunId: RunId,
      ) {
        const { statements, tracer } = traceSqlStatements();
        const context = yield* projectionStore
          .getTurnStartContext(readThreadId, readRunId)
          .pipe(Effect.withTracer(tracer));
        const lookups = statements.filter((statement) =>
          statement.includes("FROM orchestration_v2_projection_turn_items"),
        );
        assert.lengthOf(lookups, 1);
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${lookups[0]}`,
          [readThreadId, readRunId],
        )).map((row) => row.detail);
        return { ids: context.turnItems.map((item) => item.id), plan };
      });

      const lookupPlans: Array<ReadonlyArray<string>> = [];
      for (const [from, to] of [
        [1, 1_000],
        [1_001, 10_000],
      ] as const) {
        yield* addHistory(from, to);
        const { ids, plan } = yield* readItems(threadId, selectedRunId);
        assert.deepEqual(ids, selectedIds);
        lookupPlans.push(plan);
      }

      assert.deepEqual((yield* readItems(threadId, emptyRunId)).ids, []);
      assert.deepEqual(
        (yield* readItems(threadId, RunId.make("run:turn-start-items:missing"))).ids,
        [],
      );
      assert.deepEqual((yield* readItems(threadId, siblingRunId)).ids, [
        "item:turn-start-items:sibling:1",
        "item:turn-start-items:sibling:2",
      ]);
      assert.deepEqual((yield* readItems(otherThreadId, selectedRunId)).ids, [
        "item:turn-start-items:other-thread:a",
        "item:turn-start-items:other-thread:b",
      ]);
      assert.deepEqual((yield* readItems(otherThreadId, siblingRunId)).ids, []);

      for (const plan of lookupPlans) {
        const lookup = plan.filter((detail) =>
          detail.includes("orchestration_v2_projection_turn_items"),
        );
        assert.lengthOf(lookup, 1);
        assert.match(
          lookup[0]!,
          /^SEARCH .*\((?:thread_id=\? AND )?run_id=\?(?: AND thread_id=\?)?\)$/,
        );
      }
    }),
  );

  it.effect(
    "counts each shell's own runless and live-run items, skipping rolled back and missing runs",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = ProjectId.make("project:shell-item-counts");
        const busyThreadId = ThreadId.make("thread:shell-item-counts:busy");
        const emptyThreadId = ThreadId.make("thread:shell-item-counts:empty");
        const otherThreadId = ThreadId.make("thread:shell-item-counts:other");
        for (const threadId of [busyThreadId, emptyThreadId, otherThreadId]) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${threadId}:created`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: threadId,
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
            },
          });
        }
        let runWrites = 0;
        const applyRun = (
          threadId: ThreadId,
          suffix: string,
          ordinal: number,
          rolledBack: boolean,
        ) => {
          const runId = RunId.make(`run:shell-item-counts:${suffix}`);
          const rootNodeId = NodeId.make(`node:shell-item-counts:${suffix}`);
          runWrites += 1;
          return projectionStore
            .apply({
              id: EventId.make(`event:shell-item-counts:${suffix}:run:${runWrites}`),
              type: "run.created",
              threadId,
              runId,
              nodeId: rootNodeId,
              driver,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:shell-item-counts:${suffix}:user`),
                rootNodeId,
                activeAttemptId: null,
                status: rolledBack ? "rolled_back" : "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            })
            .pipe(Effect.as(runId));
        };
        let items = 0;
        let writes = 0;
        // Passing `rewrite` writes that earlier item again, possibly under another run.
        const applyItem = (threadId: ThreadId, runId: RunId | null, rewrite?: number) => {
          const ordinal = rewrite ?? (items += 1);
          writes += 1;
          return projectionStore.apply({
            id: EventId.make(`event:shell-item-counts:write:${writes}`),
            type: "turn-item.updated",
            threadId,
            ...(runId === null ? {} : { runId }),
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`turn-item:shell-item-counts:${ordinal}`),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:shell-item-counts:${ordinal}`),
              text: `item ${ordinal}`,
              streaming: false,
            },
          });
        };

        const completedRunId = yield* applyRun(busyThreadId, "busy-completed", 1, false);
        const rolledBackRunId = yield* applyRun(busyThreadId, "busy-rolled-back", 2, true);
        const otherRunId = yield* applyRun(otherThreadId, "other", 1, false);
        yield* applyItem(busyThreadId, null);
        yield* applyItem(busyThreadId, null);
        yield* applyItem(busyThreadId, completedRunId);
        yield* applyItem(busyThreadId, completedRunId);
        yield* applyItem(busyThreadId, rolledBackRunId);
        yield* applyItem(busyThreadId, RunId.make("run:shell-item-counts:missing"));
        yield* applyItem(otherThreadId, otherRunId);

        const snapshot = yield* projectionStore.getShellSnapshot({ projectId });
        const expected = [
          [busyThreadId, 4],
          [emptyThreadId, 0],
          [otherThreadId, 1],
        ] as const;
        for (const [threadId, itemCount] of expected) {
          const shell = yield* projectionStore.getThreadShell(threadId);
          assert.deepEqual(
            snapshot.threads.find((thread) => thread.id === threadId),
            shell ?? undefined,
          );
          assert.equal(shell?.itemCount, itemCount);
        }

        // Writing an item again keeps its count; moving it to another run moves the count.
        const itemCountOf = (threadId: ThreadId) =>
          projectionStore.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.itemCount));
        yield* applyItem(busyThreadId, completedRunId, 3);
        assert.equal(yield* itemCountOf(busyThreadId), 4);
        yield* applyItem(busyThreadId, rolledBackRunId, 3);
        assert.equal(yield* itemCountOf(busyThreadId), 3);
        yield* applyItem(busyThreadId, null, 3);
        assert.equal(yield* itemCountOf(busyThreadId), 4);

        // A run's rollback uncounts its items, and writing the run again counts them back.
        yield* applyRun(busyThreadId, "busy-completed", 1, true);
        assert.equal(yield* itemCountOf(busyThreadId), 3);
        yield* applyRun(busyThreadId, "busy-completed", 1, false);
        assert.equal(yield* itemCountOf(busyThreadId), 4);
        // Items written before their run exist count once it does.
        const lateRunId = RunId.make("run:shell-item-counts:late");
        yield* applyItem(otherThreadId, lateRunId);
        assert.equal(yield* itemCountOf(otherThreadId), 1);
        yield* applyRun(otherThreadId, "late", 2, false);
        assert.equal(yield* itemCountOf(otherThreadId), 2);
      }),
  );

  it.effect("does not treat visited or marked-unread state as thread activity", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const visitedOccurredAt = DateTime.add(createdAt, { seconds: 1 });
      const markedUnreadOccurredAt = DateTime.add(createdAt, { seconds: 2 });
      const threadId = ThreadId.make("thread:projection-read-state");
      const projectId = ProjectId.make("project:projection-read-state");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Projection read state",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: visitedOccurredAt,
        payload: { ...thread, lastVisitedAt: createdAt },
      });

      const visited = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(visited.thread.lastVisitedAt, createdAt);
      assert.deepEqual(visited.thread.updatedAt, createdAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:marked-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: markedUnreadOccurredAt,
        payload: thread,
      });

      const markedUnread = yield* projectionStore.getThreadProjection(threadId);
      assert.isNull(markedUnread.thread.lastVisitedAt);
      assert.deepEqual(markedUnread.thread.updatedAt, createdAt);
    }),
  );

  it.effect("dates thread activity by a run event and leaves the rest of the thread alone", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const runOccurredAt = DateTime.add(createdAt, { seconds: 5 });
      const threadId = ThreadId.make("thread:projection-activity");
      const runId = RunId.make("run:projection-activity");
      const rootNodeId = NodeId.make("node:projection-activity");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:projection-activity"),
        title: "Projection activity",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "feature/activity",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: createdAt,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-activity:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      const created = (yield* projectionStore.getThreadProjection(threadId)).thread;

      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .apply({
          id: EventId.make("event:projection-activity:run-created"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: runOccurredAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:projection-activity"),
            rootNodeId,
            activeAttemptId: null,
            status: "running" as const,
            requestedAt: runOccurredAt,
            startedAt: runOccurredAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        })
        .pipe(Effect.withTracer(tracer));
      assert.isEmpty(
        statements.filter(
          (statement) =>
            /^\s*SELECT/i.test(statement) &&
            statement.includes("orchestration_v2_projection_threads"),
        ),
      );

      const active = (yield* projectionStore.getThreadProjection(threadId)).thread;
      assert.deepEqual(active, { ...created, updatedAt: runOccurredAt });
      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.deepEqual(shell?.updatedAt, runOccurredAt);
    }),
  );

  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: { ...staleRun, status: "interrupted", completedAt: later },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);
      assert.deepEqual(
        (yield* projectionStore.getThreadRecords(threadId, ["subagents"], {
          omitSettledSubagents: true,
        })).subagents,
        [],
      );
    }),
  );

  it.effect.each([
    ["T3 Code's idle compaction", "agent", "server", undefined, true, "/compact"],
    ["compacting on return", "user", "web", "onReturn", true, "/compact"],
    ["a typed /compact", "user", "mobile", undefined, false, "/compact"],
    ["a normalized idle command", "agent", "server", undefined, true, " \t\u00a0/COMPACT\u3000\n"],
    ["an ordinary prompt with idle metadata", "user", "web", "onReturn", false, "Continue"],
  ] as const)(
    "keeps the shell on the user's last turn only during %s",
    ([name, createdBy, creationSource, idleCompaction, silent, text]) =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const key = name.replaceAll(/\W+/g, "-");
        const threadId = ThreadId.make(`thread:projection-shell-silent:${key}`);
        const runId = RunId.make(`run:projection-shell-silent:${key}`);
        const messageId = MessageId.make(`message:projection-shell-silent:${key}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:projection-shell-silent"),
            title: "Idle compaction",
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
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:message`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy,
            creationSource,
            ...(idleCompaction === undefined ? {} : { idleCompaction }),
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:run`),
          type: "run.created",
          threadId,
          runId,
          nodeId: NodeId.make(`node:projection-shell-silent:${key}`),
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: messageId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });

        const presented = Effect.gen(function* () {
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          );
          const memoryShell = ProjectionStore.threadShellFromProjection(
            yield* projectionStore.getThreadProjection(threadId),
          );
          return [sqlShell, memoryShell].map((shell) => ({
            latestRunId: shell?.latestRunId ?? null,
            activityRunStatus: shell?.activityRunStatus ?? null,
            activeRunId: shell?.activeRunId ?? null,
            latestUserMessageAt: shell?.latestUserMessageAt != null,
          }));
        });
        const visible = {
          latestRunId: runId,
          activityRunStatus: "running" as const,
          activeRunId: runId,
          latestUserMessageAt: true,
        };
        const hidden = {
          latestRunId: null,
          activityRunStatus: null,
          activeRunId: null,
          latestUserMessageAt: false,
        };
        assert.deepStrictEqual(yield* presented, [
          silent ? hidden : visible,
          silent ? hidden : visible,
        ]);

        // A follow-up removed before it started stays latest unless a visible run outlives it.
        const removedRunId = RunId.make(`run:projection-shell-silent:${key}:removed`);
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:removed`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...(yield* projectionStore.getThreadProjection(threadId)).runs[0]!,
            id: removedRunId,
            ordinal: 2,
            userMessageId: MessageId.make(`message:projection-shell-silent:${key}:removed`),
            status: "cancelled",
            startedAt: null,
            completedAt: now,
          },
        });
        assert.deepStrictEqual(
          (yield* presented).map((shell) => shell.latestRunId),
          silent ? [removedRunId, removedRunId] : [runId, runId],
        );

        // A run that fails outright, e.g. on a provider error, needs the user too.
        const running = (yield* projectionStore.getThreadProjection(threadId)).runs[0]!;
        const setRunStatus = (status: "failed" | "running") =>
          projectionStore.apply({
            id: EventId.make(`event:projection-shell-silent:${key}:run-${status}`),
            type: "run.updated",
            threadId,
            occurredAt: now,
            payload: { ...running, status, completedAt: status === "failed" ? now : null },
          });
        yield* setRunStatus("failed");
        assert.deepStrictEqual(
          (yield* presented).map((shell) => shell.latestRunId),
          [runId, runId],
        );
        yield* setRunStatus("running");

        // Claude can finish the run successfully even when its /compact failed.
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-silent:${key}:failure`),
          type: "turn-item.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:projection-shell-silent:${key}:compaction`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            type: "compaction",
            driver,
            status: "failed",
            title: "Context compaction failed",
            summary: "Not enough messages to compact.",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          },
        });
        // A failure needs the user, so it surfaces even though its prompt stays hidden.
        assert.deepStrictEqual(
          yield* presented,
          [visible, visible].map((shell) =>
            silent ? { ...shell, latestUserMessageAt: false } : shell,
          ),
        );
      }),
  );

  it.effect("only exposes interruptible runs through the shell activeRunId", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-shell-interruptible");
      const projectId = ProjectId.make("project:projection-shell-interruptible");
      const runId = RunId.make("run:projection-shell-interruptible");
      const rootNodeId = NodeId.make("node:projection-shell-interruptible");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-shell-interruptible"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Interruptible shell run",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:running"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });

      let shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "running");
      assert.equal(shell?.activeRunId, runId);
      assert.equal(
        shell?.latestRunRequestedAt && DateTime.toEpochMillis(shell.latestRunRequestedAt),
        DateTime.toEpochMillis(now),
      );
      assert.equal(
        shell?.latestRunStartedAt && DateTime.toEpochMillis(shell.latestRunStartedAt),
        DateTime.toEpochMillis(now),
      );
      assert.isNull(shell?.latestRunCompletedAt);

      const requestId = RuntimeRequestId.make("request:projection-shell-question");
      for (const [responseCapability, blocking] of [
        [{ type: "message" }, false],
        [{ type: "live", providerSessionId: ProviderSessionId.make("session:question") }, true],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-question:${responseCapability.type}`),
          type: "runtime-request.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: rootNodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        });
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        )!;
        for (const questionShell of [
          sqlShell,
          ProjectionStore.threadShellFromProjection(projection),
        ]) {
          assert.equal(questionShell.activeRunId, runId);
          assert.deepEqual(questionShell.pendingRuntimeRequest, {
            id: requestId,
            kind: "user_input",
            createdAt: now,
            blocking,
          });
        }
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:waiting"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "waiting" },
      });

      shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "waiting");
      assert.isNull(shell?.activeRunId);
      const later = DateTime.add(now, { hours: 1 });
      for (const status of ["queued", "cancelled"] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:clock:newer:${status}`),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...run,
            id: RunId.make("run:clock:newer"),
            ordinal: 2,
            status,
            requestedAt: later,
            startedAt: null,
            completedAt: status === "cancelled" ? later : null,
          },
        });
        for (const activityStatus of ["preparing", "running", "waiting", "completed"] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:clock:${status}:${activityStatus}`),
            type: "run.updated",
            threadId,
            occurredAt: later,
            payload: {
              ...run,
              status: activityStatus,
              startedAt: activityStatus === "preparing" ? null : now,
              completedAt: activityStatus === "completed" ? later : null,
            },
          });
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (row) => row.id === threadId,
          )!;
          const memoryShell = ProjectionStore.threadShellFromProjection(projection);
          const expected = activityStatus === "completed" ? null : DateTime.toEpochMillis(now);
          const timestamp = (value: DateTime.Utc | null | undefined) =>
            value == null ? null : DateTime.toEpochMillis(value);
          assert.equal(timestamp(sqlShell.activityRunStartedAt), expected);
          assert.equal(timestamp(memoryShell.activityRunStartedAt), expected);
          // A queued message steered or removed before it started never ran, so the run that did presents.
          for (const shell of [sqlShell, memoryShell]) {
            assert.equal(shell.latestRunId, status === "cancelled" ? runId : "run:clock:newer");
          }
        }
      }
      // Removing a message after the earlier run ended leaves the cancelled run as the latest.
      yield* projectionStore.apply({
        id: EventId.make("event:clock:ended-before-cancel"),
        type: "run.updated",
        threadId,
        occurredAt: later,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
      const endedBeforeCancelProjection = yield* projectionStore.getThreadProjection(threadId);
      for (const shell of [
        (yield* projectionStore.getShellSnapshot()).threads.find((row) => row.id === threadId)!,
        ProjectionStore.threadShellFromProjection(endedBeforeCancelProjection),
      ]) {
        assert.equal(shell.latestRunId, "run:clock:newer");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:clock:newer:held"),
        type: "run.updated",
        threadId,
        occurredAt: later,
        payload: {
          ...run,
          id: RunId.make("run:clock:newer"),
          ordinal: 2,
          status: "queued",
          queueHeld: true,
          requestedAt: later,
          startedAt: null,
          completedAt: null,
        },
      });
      const heldProjection = yield* projectionStore.getThreadProjection(threadId);
      const heldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const heldShell of [
        heldSqlShell,
        ProjectionStore.threadShellFromProjection(heldProjection),
      ]) {
        assert.equal(heldShell.latestRunId, runId);
        assert.equal(heldShell.status, "completed");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:held-first"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: { ...run, status: "queued", queueHeld: true, startedAt: null, completedAt: null },
      });
      const onlyHeldProjection = yield* projectionStore.getThreadProjection(threadId);
      const onlyHeldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const onlyHeldShell of [
        onlyHeldSqlShell,
        ProjectionStore.threadShellFromProjection(onlyHeldProjection),
      ]) {
        assert.isNull(onlyHeldShell.latestRunId);
        assert.equal(onlyHeldShell.status, "idle");
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:wake"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: {
          ...run,
          status: "running",
          requestedAt: later,
          startedAt: later,
          workStartedAt: now,
        },
      });
      const wakeProjection = yield* projectionStore.getThreadProjection(threadId);
      const wakeSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const wakeShell of [
        wakeSqlShell,
        ProjectionStore.threadShellFromProjection(wakeProjection),
      ]) {
        assert.equal(
          wakeShell.activityRunStartedAt && DateTime.toEpochMillis(wakeShell.activityRunStartedAt),
          DateTime.toEpochMillis(now),
        );
      }
    }),
  );

  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const memberThreadId = ThreadId.make("thread:recovery-candidates:member");
      const childThreadId = ThreadId.make("thread:recovery-candidates:child");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });

      for (const threadId of [settledThreadId, runningThreadId, memberThreadId, childThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const memberId = NodeId.make("node:recovery-candidates:member");
      const childRootNodeId = NodeId.make("node:recovery-candidates:child-root");
      const nativeTaskRef = { driver, nativeId: "workflow:agent:1", strength: "strong" as const };
      const memberNode = {
        id: memberId,
        threadId: memberThreadId,
        runId: null,
        parentNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        rootNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: memberId,
          threadId: memberThreadId,
          runId: null,
          parentNodeId: memberNode.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef,
          prompt: "Do the work",
          title: "Member",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      for (const [threadId, node] of [
        [memberThreadId, memberNode],
        [
          childThreadId,
          {
            ...memberNode,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:node:${node.id}`),
          type: "node.updated",
          threadId,
          nodeId: node.id,
          driver,
          occurredAt: now,
          payload: node,
        });
      }

      const recoveryThreadIds = yield* projectionStore.getRecoveryThreadIds("runtime");
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.include(recoveryThreadIds, memberThreadId);
      assert.include(recoveryThreadIds, childThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
      const memberRecovery = yield* projectionStore.getRuntimeRecoveryProjection(memberThreadId);
      const childRecovery = yield* projectionStore.getRuntimeRecoveryProjection(childThreadId);
      assert.deepEqual(
        memberRecovery.subagents.map((subagent) => subagent.id),
        [memberId],
      );
      assert.deepEqual(
        memberRecovery.nodes.map((node) => node.id),
        [memberId],
      );
      assert.deepEqual(
        childRecovery.nodes.map((node) => node.id),
        [childRootNodeId],
      );
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member-cancelled"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...memberRecovery.subagents[0]!,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childThreadId);
    }),
  );

  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedRunId = RunId.make("run:limit-shell:queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:queued"),
        type: "run.created",
        threadId,
        runId: queuedRunId,
        nodeId: NodeId.make("node:limit-shell:queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: queuedRunId,
          ordinal: original.ordinal + 1,
          rootNodeId: NodeId.make("node:limit-shell:queued"),
          userMessageId: MessageId.make("message:limit-shell:queued"),
          status: "queued",
          startedAt: null,
          completedAt: null,
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedProjection = yield* store.getThreadProjection(threadId);
      const queuedMemoryShell = ProjectionStore.threadShellFromProjection(queuedProjection);
      const queuedSqlShell = (yield* store.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      assert.equal(queuedMemoryShell.status, "failed");
      assert.equal(queuedMemoryShell.latestRunId, original.id);
      assert.equal(queuedSqlShell.status, "failed");
      assert.equal(queuedSqlShell.latestRunId, original.id);
      assert.equal(queuedProjection.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      const cancelledRunId = RunId.make("run:limit-shell:cancelled-queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued"),
        type: "run.created",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: cancelledRunId,
          ordinal: original.ordinal + 2,
          rootNodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          userMessageId: MessageId.make("message:limit-shell:cancelled-queued"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued-message"),
        type: "turn-item.updated",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("limit-shell:cancelled-queued-message"),
          threadId,
          runId: cancelledRunId,
          nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:limit-shell:cancelled-queued"),
          inputIntent: "turn_start",
          text: "cancelled before the provider started",
          attachments: [],
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const aheadRunId = RunId.make("run:limit-shell:ran-ahead");
      yield* store.apply({
        id: EventId.make("event:limit-shell:ran-ahead"),
        type: "run.created",
        threadId,
        runId: aheadRunId,
        nodeId: NodeId.make("node:limit-shell:ran-ahead"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: aheadRunId,
          ordinal: original.ordinal + 3,
          rootNodeId: NodeId.make("node:limit-shell:ran-ahead"),
          userMessageId: MessageId.make("message:limit-shell:ran-ahead"),
          status: "completed",
          startedAt: DateTime.subtract(now, { minutes: 10 }),
          completedAt: DateTime.subtract(now, { minutes: 5 }),
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${aheadRunId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${queuedRunId}`;
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${cancelledRunId}`;
      const [originalRow] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );

  it.effect("returns a usage limit without a reset time only to the fallback branch", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-no-reset");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:limit-no-reset:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("limit-no-reset:error"),
          threadId,
          runId: original.id,
          nodeId: original.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed" as const,
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error" as const,
          failure: {
            class: "usage_limit" as const,
            message: "Plan limit reached.",
            code: "usageLimitExceeded",
            retryable: null,
          },
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-no-reset:run:failed"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...original, status: "failed" },
      });
      const options = { now, autoResume: true, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(options)).find((row) => row.id === threadId),
      );
      const fallback = (yield* store.getLimitRecoveryCandidates({
        ...options,
        withoutReset: true,
      })).find((row) => row.id === threadId);
      assert.strictEqual(fallback?.lastErrorClass, "usage_limit");
      assert.isNull(fallback?.usageLimitResetAt ?? null);
      // Nothing is armed for it: the recovery command needs a reset time.
      assert.isNull(
        UsageLimitRecoveryWorker.limitRecoveryCommand(fallback!, true, DateTime.toEpochMillis(now)),
      );
    }),
  );

  it.effect(
    "does not freshly arm limit recovery for a subagent of a settled parent",
    () => settledParentRecovery,
  );

  it.effect("memory replay does not freshly arm a child of a settled parent", () =>
    settledParentRecovery.pipe(Effect.provide(ProjectionStore.layerMemory)),
  );

  it.effect("projects one shared provider session into multiple thread bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-shared-provider-session");
      const firstThreadId = ThreadId.make("thread:projection-shared-provider-session:first");
      const secondThreadId = ThreadId.make("thread:projection-shared-provider-session:second");
      const providerSessionId = ProviderSessionId.make(
        "provider-session:projection-shared-provider-session",
      );
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Shared provider session",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const session = {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "error" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: "provider process exited",
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-thread"),
        type: "thread.created",
        threadId: firstThreadId,
        occurredAt: now,
        payload: makeThread(firstThreadId),
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:second-thread"),
        type: "thread.created",
        threadId: secondThreadId,
        occurredAt: now,
        payload: makeThread(secondThreadId),
      });
      for (const [threadId, suffix] of [
        [firstThreadId, "first"],
        [secondThreadId, "second"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shared-provider-session:${suffix}-binding`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }

      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getShellSnapshot()).threads
          .filter((thread) => thread.id === firstThreadId || thread.id === secondThreadId)
          .map((thread) => ({
            id: thread.id,
            lastError: thread.lastError,
          })),
        [
          { id: firstThreadId, lastError: "provider process exited" },
          { id: secondThreadId, lastError: "provider process exited" },
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-detached"),
        type: "provider-session.detached",
        threadId: firstThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: { providerSessionId, detachedAt: now },
      });

      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions,
        0,
      );
      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions,
        1,
      );
    }),
  );

  it.effect("looks up a thread's last provider error through its own session bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { minutes: 1 });
      const projectId = ProjectId.make("project:projection-session-error-lookup");
      const attachErroredSession = Effect.fnUntraced(function* (
        name: string,
        lastError: string,
        updatedAt: DateTime.Utc,
      ) {
        const threadId = ThreadId.make(`thread:projection-session-error-lookup:${name}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-session-error-lookup:${name}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
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
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-session-error-lookup:${name}:session`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: updatedAt,
          payload: {
            id: ProviderSessionId.make(`provider-session:projection-session-error-lookup:${name}`),
            driver,
            providerInstanceId,
            status: "error",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: updatedAt,
            updatedAt,
            lastError,
          },
        });
        return threadId;
      });

      const failure = {
        class: "usage_limit" as const,
        message: "Plan limit reached.",
        resetAt: "2099-01-01T00:00:00.000Z",
        code: "usageLimitExceeded",
        retryable: null,
      };
      const threadId = yield* attachErroredSession("own", failure.message, now);
      const runId = RunId.make("run:projection-session-error-lookup:own");
      const rootNodeId = NodeId.make("node:projection-session-error-lookup:own");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-session-error-lookup:own:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-session-error-lookup:own"),
          rootNodeId,
          activeAttemptId: null,
          status: "failed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-session-error-lookup:own:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("projection-session-error-lookup:own:error"),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure,
        },
      });
      for (let index = 0; index < 24; index++) {
        yield* attachErroredSession(`other-${index}`, "other session failed", later);
      }

      const { statements, tracer } = traceSqlStatements();
      const shell = yield* projectionStore.getShellSnapshot().pipe(Effect.withTracer(tracer));
      assert.equal(
        shell.threads.find((thread) => thread.id === threadId)?.lastError,
        failure.message,
      );
      const candidates = yield* projectionStore
        .getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })
        .pipe(Effect.withTracer(tracer));
      const candidate = candidates.find((row) => row.id === threadId);
      assert.isDefined(candidate);
      assert.include(candidate, {
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: failure.resetAt,
        latestRunId: runId,
      });

      for (const marker of ["AS blocking_failure_payload_json", "AS failure_payload_json"]) {
        const statement = statements.find((query) => query.includes(marker));
        assert.isDefined(statement, marker);
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        )).map((row) => row.detail);
        const bindingLookup = plan.findIndex((detail) => detail.startsWith("SEARCH binding "));
        const sessionLookup = plan.findIndex((detail) => detail.startsWith("SEARCH session "));
        assert.isAtLeast(bindingLookup, 0, marker);
        assert.include(
          plan[bindingLookup],
          "orchestration_v2_projection_provider_session_bindings_thread_idx (thread_id=?)",
        );
        assert.isAbove(sessionLookup, bindingLookup, marker);
        assert.include(plan[sessionLookup], "(provider_session_id=?)");
        const errorLookups = plan.filter(
          (detail) =>
            /^SEARCH (?:item|error) /.test(detail) && !detail.includes("(turn_item_id=?)"),
        );
        assert.lengthOf(errorLookups, marker.includes("blocking") ? 2 : 1, marker);
        for (const errorLookup of errorLookups) {
          assert.include(errorLookup, "turn_items_failed_error_idx");
          assert.include(errorLookup, "(thread_id=? AND run_id=? AND node_id=?)");
        }
      }
    }),
  );

  it.effect("prefers inbox requests in both shell paths and preserves fallback precedence", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "decision-inbox-shell";
      const threadId = yield* addRolledBackRecoveryCandidate(suffix);
      const runId = RunId.make(`run:${suffix}:rolled-back`);
      const nodeId = NodeId.make(`node:${suffix}:rolled-back`);
      const now = DateTime.makeUnsafe("2026-10-13T00:00:00.000Z");
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'waiting', payload_json = json_set(payload_json, '$.status', 'waiting')
        WHERE run_id = ${runId}
      `;
      yield* store.apply({
        id: EventId.make("decision-inbox:secret"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("decision-inbox:secret"),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "secret_request",
          label: "Test credential",
          reason: "Test pending input",
          secretStatus: "pending",
        },
      });
      const request = (
        id: string,
        kind: OrchestrationV2RuntimeRequest["kind"],
        minute: number,
      ): OrchestrationV2RuntimeRequest => ({
        id: RuntimeRequestId.make(id),
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: {
          type: "live",
          providerSessionId: ProviderSessionId.make("decision-inbox-session"),
        },
        createdAt: DateTime.add(now, { minutes: minute }),
        resolvedAt: null,
      });
      const input = request("decision-inbox:input", "user_input", 1);
      const commandA = request("decision-inbox:command:a", "command", 2);
      const commandB = request("decision-inbox:command:b", "command", 2);
      const auth = request("decision-inbox:auth", "auth_refresh", 3);
      const tool = request("decision-inbox:tool", "dynamic_tool_call", 4);
      const resolved = {
        ...request("decision-inbox:resolved", "command", 5),
        status: "resolved" as const,
        resolvedAt: now,
      };
      const save = (value: OrchestrationV2RuntimeRequest) =>
        store.apply({
          id: EventId.make(`${value.id}:${value.status}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: now,
          payload: value,
        });
      const assertSelected = (expected: string | null) =>
        Effect.gen(function* () {
          const projection = yield* store.getThreadProjection(threadId);
          const snapshot = yield* store.getShellSnapshot();
          const sqlShell = snapshot.threads.find((shell) => shell.id === threadId);
          const liveShell = yield* store.getThreadShell(threadId);
          const memoryShell = ProjectionStore.threadShellFromProjection(projection);
          assert.equal(sqlShell?.pendingRuntimeRequest?.id ?? null, expected);
          assert.equal(liveShell?.pendingRuntimeRequest?.id ?? null, expected);
          assert.equal(memoryShell.pendingRuntimeRequest?.id ?? null, expected);
        });
      for (const value of [input, commandA, commandB, auth, tool, resolved]) yield* save(value);
      yield* assertSelected("decision-inbox:command:b");
      const resolve = (value: OrchestrationV2RuntimeRequest) =>
        save({ ...value, status: "resolved", resolvedAt: now });
      yield* resolve(commandB);
      yield* assertSelected("decision-inbox:command:a");
      yield* resolve(commandA);
      yield* assertSelected("decision-inbox:input");
      yield* resolve(input);
      yield* assertSelected("decision-inbox:tool");
      yield* resolve(tool);
      yield* assertSelected("decision-inbox:auth");
      yield* resolve(auth);
      yield* assertSelected("decision-inbox:secret");
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'completed', payload_json = json_set(payload_json, '$.status', 'completed')
        WHERE run_id = ${runId}
      `;
      yield* assertSelected(null);
    }),
  );

  it.effect("selects the latest waiting secret only from active runs", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "shell-pending-secret";
      const threadId = yield* addRolledBackRecoveryCandidate(suffix);
      const runId = RunId.make(`run:${suffix}:rolled-back`);
      const nodeId = NodeId.make(`node:${suffix}:rolled-back`);
      const now = yield* DateTime.now;
      const addSecret = (id: string, ordinal: number, status: "waiting" | "completed") =>
        projectionStore.apply({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: DateTime.add(now, { seconds: ordinal }),
            type: "secret_request",
            label: "Test credential",
            reason: "Test pending input",
            secretStatus: status === "waiting" ? "pending" : "saved",
          },
        });
      yield* addSecret("secret:a", 2, "waiting");
      yield* addSecret("secret:b", 3, "waiting");
      yield* addSecret("secret:c", 4, "completed");

      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'running', payload_json = json_set(payload_json, '$.status', 'running')
        WHERE run_id = ${runId}
      `;
      const secretOnlyShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const secretOnlyProjection = yield* projectionStore.getThreadProjection(threadId);
      for (const shell of [
        secretOnlyShell,
        ProjectionStore.threadShellFromProjection(secretOnlyProjection),
      ]) {
        assert.equal(shell?.pendingRuntimeRequest?.id, "secret:b");
        assert.isTrue(shell?.pendingRuntimeRequest?.blocking);
      }

      const requestId = RuntimeRequestId.make(`request:${suffix}:async`);
      yield* projectionStore.apply({
        id: EventId.make(`event:${suffix}:async`),
        type: "runtime-request.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.subtract(now, { seconds: 1 }),
          resolvedAt: null,
        },
      });

      for (const status of [
        "preparing",
        "starting",
        "running",
        "waiting",
        "completed",
        "rolled_back",
      ]) {
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status})
          WHERE run_id = ${runId}
        `;
        const shell = yield* projectionStore.getShellSnapshot();
        const thread = shell.threads.find((candidate) => candidate.id === threadId);
        assert.isDefined(thread);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const terminal = status === "completed" || status === "rolled_back";
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.id, memoryShell.pendingRuntimeRequest?.id],
          terminal ? [requestId, requestId] : ["secret:b", "secret:b"],
        );
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.blocking, memoryShell.pendingRuntimeRequest?.blocking],
          terminal ? [false, false] : [true, true],
        );
      }
    }),
  );

  it.effect("counts imported runless history inherited by fork shells", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-imported-fork-shell");
      const sourceThreadId = ThreadId.make("thread:projection-imported-fork-shell:source");
      const targetThreadId = ThreadId.make("thread:projection-imported-fork-shell:target");
      const sourceRunId = RunId.make("run:projection-imported-fork-shell:source");
      const rootNodeId = NodeId.make("node:projection-imported-fork-shell:source");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: sourceThreadId,
          projectId,
          title: "Imported fork source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Imported fork target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-run"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-imported-fork-shell:run"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const applyAssistantItem = (suffix: string, runId: RunId | null, ordinal: number) =>
        projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:item:${suffix}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          ...(runId === null ? {} : { runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-imported-fork-shell:${suffix}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message:projection-imported-fork-shell:${suffix}`),
            text: suffix,
            streaming: false,
          },
        });

      yield* applyAssistantItem("imported-one", null, 1);
      yield* applyAssistantItem("imported-two", null, 2);
      yield* applyAssistantItem("native-run", sourceRunId, 3);

      const shell = yield* projectionStore.getShellSnapshot();
      const targetShell = shell.threads.find((thread) => thread.id === targetThreadId);
      const targetProjection = yield* projectionStore.getThreadProjection(targetThreadId);

      assert.isDefined(targetShell);
      assert.equal(targetShell.itemCount, 0);
      assert.equal(targetShell.visibleItemCount, 4);
      assert.equal(targetProjection.visibleTurnItems.length, 4);
    }),
  );

  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-rollback-prune");
      const projectId = ProjectId.make("project:projection-rollback-prune");
      const runId = RunId.make("run:projection-rollback-prune");
      const attemptId = RunAttemptId.make("attempt:projection-rollback-prune");
      const rootNodeId = NodeId.make("node:projection-rollback-prune:root");
      const assistantNodeId = NodeId.make("node:projection-rollback-prune:assistant");
      const providerThreadId = ProviderThreadId.make("provider-thread:projection-rollback-prune");
      const providerTurnId = ProviderTurnId.make("provider-turn:projection-rollback-prune");
      const userMessageId = MessageId.make("message:projection-rollback-prune:user");
      const assistantMessageId = MessageId.make("message:projection-rollback-prune:assistant");
      const userTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:user");
      const assistantTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:assistant");
      const backgroundTurnItemId = TurnItemId.make(
        "turn-item:projection-rollback-prune:background",
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection rollback prune",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:attempt-created"),
        type: "run-attempt.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "assistant_message",
          status: "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "rolled back user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: assistantMessageId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          role: "assistant",
          text: "rolled back assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: "rolled back user",
          attachments: [],
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantTurnItemId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: assistantMessageId,
          text: "rolled back assistant",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:background-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: backgroundTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 300,
          status: "running",
          title: "rolled back background command",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-rolled-back"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "rolled_back",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["rolled_back"],
      );
      assert.deepEqual(
        projection.nodes.map((node) => [node.id, node.status]),
        [
          [assistantNodeId, "completed"],
          [rootNodeId, "rolled_back"],
        ],
      );
      assert.lengthOf(projection.providerTurns, 1);
      assert.lengthOf(projection.messages, 2);
      assert.lengthOf(projection.turnItems, 3);
      assert.lengthOf(projection.visibleTurnItems, 0);

      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("keeps fork visible items stable after a source run is rolled back", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-source-rollback");
      const sourceThreadId = ThreadId.make("thread:projection-fork-source-rollback:source");
      const targetThreadId = ThreadId.make(`${sourceThreadId}:target`);
      const sourceProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:source",
      );
      const targetProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:target",
      );
      const sourceRun1Id = RunId.make("run:projection-fork-source-rollback:source:1");
      const sourceRun2Id = RunId.make("run:projection-fork-source-rollback:source:2");
      const sourceRun3Id = RunId.make("run:projection-fork-source-rollback:source:3");
      const sourceRun1NodeId = NodeId.make("node:projection-fork-source-rollback:source:1");
      const sourceRun2NodeId = NodeId.make("node:projection-fork-source-rollback:source:2");
      const sourceRun3NodeId = NodeId.make("node:projection-fork-source-rollback:source:3");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Projection fork source rollback source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: sourceProviderThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Projection fork source rollback target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: targetProviderThreadId,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRun2Id,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [ordinal, runId, nodeId, promptText, responseText] of [
        [1, sourceRun1Id, sourceRun1NodeId, "source one", "one"],
        [2, sourceRun2Id, sourceRun2NodeId, "source two", "two"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make(
              `message:projection-fork-source-rollback:user:${ordinal}`,
            ),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:user-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:user:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:projection-fork-source-rollback:user:${ordinal}`),
            inputIntent: "turn_start",
            text: promptText,
            attachments: [],
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:assistant-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:assistant:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(
              `message:projection-fork-source-rollback:assistant:${ordinal}`,
            ),
            text: responseText,
            streaming: false,
          },
        });
      }

      const targetBeforeRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetBeforeRollback.visibleTurnItems.map((row) => row.item.type),
        ["user_message", "assistant_message", "user_message", "assistant_message", "fork"],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-2-rolled-back"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun2Id,
        nodeId: sourceRun2NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun2Id,
          threadId: sourceThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:2"),
          rootNodeId: sourceRun2NodeId,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const sourceMessages = (yield* projectionStore.getThreadRecords(sourceThreadId, ["messages"]))
        .messages;
      assert.deepEqual(
        sourceMessages,
        (yield* projectionStore.getThreadProjection(sourceThreadId)).messages,
      );
      const targetAfterRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      const shellSnapshot = yield* projectionStore.getShellSnapshot();
      for (const shell of [
        yield* projectionStore.getThreadShell(sourceThreadId),
        shellSnapshot.threads.find((thread) => thread.id === sourceThreadId),
      ]) {
        assert.equal(shell?.itemCount, 2);
      }
      for (const shell of [
        yield* projectionStore.getThreadShell(targetThreadId),
        shellSnapshot.threads.find((thread) => thread.id === targetThreadId),
      ]) {
        assert.equal(shell?.visibleItemCount, targetAfterRollback.visibleTurnItems.length);
      }
      const forwardPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 2,
      });
      assert.deepEqual(forwardPage.items, targetAfterRollback.visibleTurnItems.slice(0, 2));
      assert.equal(forwardPage.totalItems, targetAfterRollback.visibleTurnItems.length);
      assert.isTrue(forwardPage.hasMore);
      const followingPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
        afterPosition: 1,
      });
      assert.deepEqual(followingPage.items, targetAfterRollback.visibleTurnItems.slice(2));
      assert.isFalse(followingPage.hasMore);
      assert.isTrue(followingPage.hasEarlier);
      const newestPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 2,
        beforePosition: Number.POSITIVE_INFINITY,
      });
      assert.deepEqual(newestPage.items, targetAfterRollback.visibleTurnItems.slice(-2));
      assert.isFalse(newestPage.hasMore);
      assert.isTrue(newestPage.hasEarlier);
      const earlierPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
        beforePosition: newestPage.items[0]!.position,
      });
      assert.deepEqual(earlierPage.items, targetAfterRollback.visibleTurnItems.slice(0, -2));
      assert.isTrue(earlierPage.hasMore);
      assert.isFalse(earlierPage.hasEarlier);
      const tracedTimelinePage = (limit: number) =>
        Effect.gen(function* () {
          const { statements, tracer } = traceSqlStatements();
          const page = yield* projectionStore
            .getTimelinePage(targetThreadId, { view: "activity", limit })
            .pipe(Effect.withTracer(tracer));
          return { page, statements };
        });
      const singleItemPage = yield* tracedTimelinePage(1);
      const fullPage = yield* tracedTimelinePage(10);
      assert.deepEqual(fullPage.page.items, targetAfterRollback.visibleTurnItems);
      assert.lengthOf(fullPage.statements, singleItemPage.statements.length);

      assert.deepEqual(
        targetAfterRollback.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.title,
        ]),
        [
          ["inherited", "user_message", "source one"],
          ["inherited", "assistant_message", "one"],
          ["inherited", "user_message", "source two"],
          ["inherited", "assistant_message", "two"],
          ["synthetic", "fork", "Forked from conversation"],
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-3"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun3Id,
        nodeId: sourceRun3NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun3Id,
          threadId: sourceThreadId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:3"),
          rootNodeId: sourceRun3NodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const nowIso = DateTime.formatIso(now);
      for (let index = 0; index < 300; index += 1) {
        const id = `turn-item:projection-fork-source-rollback:post-fork:${index}`;
        const ordinal = index < 10 ? 190 + index : 300 + index;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun3Id}, ${sourceRun3NodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'command_execution',
            'completed', ${nowIso}, ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun3Id,
              nodeId: sourceRun3NodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "post fork",
              input: "echo later",
              output: "later",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const { statements, tracer } = traceSqlStatements();
      const boundedFork = yield* projectionStore
        .getThreadSnapshotWindow(targetThreadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      const retained = statements.filter((statement) =>
        statement.includes("WITH RECURSIVE retained"),
      );
      assert.lengthOf(retained, 1);
      // The settled-leaf index also starts with thread_id, and through it this lookup fetches
      // every node of the thread to check its status.
      const retainedPlan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${retained[0]}`,
      )).map((row) => row.detail);
      assert.match(
        retainedPlan.find((detail) => detail.startsWith("SEARCH live ")) ?? "",
        /nodes_live_idx/,
        JSON.stringify(retainedPlan),
      );
      assert.lengthOf(
        statements.filter((statement) => statement.includes("SELECT node.payload_json")),
        1,
      );
      assert.lengthOf(boundedFork.projection.turnItems, 0);
      assert.deepEqual(
        boundedFork.projection.visibleTurnItems.map((row) => [row.visibility, row.item.type]),
        [
          ["inherited", "user_message"],
          ["inherited", "assistant_message"],
          ["synthetic", "fork"],
        ],
      );
      const parentPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
        anchorItemId: TurnItemId.make("turn-item:projection-fork-source-rollback:assistant:1"),
      });
      assert.deepEqual(
        parentPage.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );

      const emptyBoundaryRunId = RunId.make(
        "run:projection-fork-source-rollback:source:empty-boundary",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-boundary-run"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: emptyBoundaryRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyBoundaryRunId,
          threadId: sourceThreadId,
          ordinal: 3,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make(
            "message:projection-fork-source-rollback:user:empty-boundary",
          ),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const emptyBoundaryFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        emptyBoundaryFork.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source two", "two", "fork"],
      );
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${sourceRun2Id})
        WHERE thread_id = ${targetThreadId}
      `;

      const targetRunId = RunId.make("run:projection-fork-source-rollback:target:1");
      const targetNodeId = NodeId.make("node:projection-fork-source-rollback:target:1");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-run"),
        type: "run.updated",
        threadId: targetThreadId,
        runId: targetRunId,
        nodeId: targetNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: targetRunId,
          threadId: targetThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: targetProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:target:1"),
          rootNodeId: targetNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      for (let ordinal = 1; ordinal <= 102; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:target:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${targetThreadId}, ${targetRunId}, ${targetNodeId}, ${targetProviderThreadId},
            NULL, NULL, ${ordinal}, 'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: targetThreadId,
              runId: targetRunId,
              nodeId: targetNodeId,
              providerThreadId: targetProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `target ${ordinal}`,
              input: `echo target ${ordinal}`,
              output: "target",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const nestedThreadId = ThreadId.make("thread:projection-fork-source-rollback:nested");
      for (const ordinal of [
        ...Array.from({ length: 99 }, (_, index) => index + 1),
        ...Array.from({ length: 99 }, (_, index) => index + 101),
      ]) {
        const runId = ordinal < 100 ? sourceRun1Id : sourceRun2Id;
        const id =
          ordinal === 1
            ? "target:turn-item:projection-fork-source-rollback:target:1"
            : `turn-item:projection-fork-source-rollback:lineage:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `lineage ${ordinal}`,
              input: "echo lineage",
              output: "lineage",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const collisionPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 500,
      });
      const inheritedCollision = collisionPage.items.find(
        (row) =>
          row.sourceThreadId === sourceThreadId &&
          row.sourceItemId === "target:turn-item:projection-fork-source-rollback:target:1",
      );
      const targetCollision = collisionPage.items.find(
        (row) =>
          row.sourceThreadId === targetThreadId &&
          row.sourceItemId === "turn-item:projection-fork-source-rollback:target:1",
      );
      assert.equal(inheritedCollision?.item.title, "lineage 1");
      assert.equal(targetCollision?.item.title, "target 1");
      const inheritedSupersededNodeId = NodeId.make(
        "node:projection-fork-source-rollback:inherited-superseded",
      );
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:projection-fork-source-rollback:inherited-superseded',
          ${sourceThreadId}, ${sourceRun2Id}, 2, ${inheritedSupersededNodeId}, 'codex',
          ${providerInstanceId}, ${sourceProviderThreadId}, NULL, 'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:projection-fork-source-rollback:inherited-superseded",
            runId: sourceRun2Id,
            attemptOrdinal: 2,
            rootNodeId: inheritedSupersededNodeId,
            providerInstanceId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            reason: "retry",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      for (let ordinal = 201; ordinal <= 300; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:hidden-interrupt:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun2Id}, ${inheritedSupersededNodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'run_interrupt_result',
            'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun2Id,
              nodeId: inheritedSupersededNodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "Stopped",
              message: "Stopped",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "run_interrupt_result",
            })}
          )
        `;
      }
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:nested-thread"),
        type: "thread.created",
        threadId: nestedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: nestedThreadId,
          projectId,
          title: "Nested bounded fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: targetThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: targetThreadId, runId: targetRunId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const boundedNested = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        boundedNested.projection.visibleTurnItems.map((row) => row.item.type),
        [
          "user_message",
          "assistant_message",
          "fork",
          "command_execution",
          "command_execution",
          "fork",
        ],
      );

      const nestedInitial = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: yield* projectionStore
          .getThreadSnapshotWindow(nestedThreadId, {
            rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          })
          .pipe(Effect.map((snapshot) => snapshot.projection)),
        snapshotSequence: 1,
      });
      const expectedNestedIds = (yield* projectionStore.getThreadProjection(
        nestedThreadId,
      )).visibleTurnItems.map((row) => String(row.sourceItemId));
      const nestedIds = nestedInitial.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let nestedCursor = nestedInitial.historyCursor;
      let nestedPages = 1;
      while (nestedCursor !== null) {
        const decoded = decodeThreadHistoryCursor(nestedCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          anchorItemId: TurnItemId.make(decoded.si),
          anchorThreadId: ThreadId.make(decoded.st),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor: nestedCursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        nestedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        nestedCursor = page.nextCursor;
        nestedPages += 1;
      }
      assert.isAtLeast(nestedPages, 3);
      assert.lengthOf(nestedIds, expectedNestedIds.length);
      assert.deepEqual(nestedIds, expectedNestedIds);

      const nestedTurnWindow = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      const nestedTurnPage = buildBoundedThreadProjection({
        projection: nestedTurnWindow.projection,
        snapshotSequence: 1,
      });
      const turnPagedIds = nestedTurnPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let turnCursor = nestedTurnPage.historyCursor;
      while (turnCursor !== null) {
        const anchor = decodeThreadHistoryCursor(turnCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: turnCursor,
          snapshotSequence: 1,
        });
        turnPagedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        turnCursor = page.nextCursor;
      }
      assert.deepEqual(turnPagedIds, expectedNestedIds);
      const fullNested = yield* projectionStore.getThreadProjection(nestedThreadId);
      const nestedForward = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "activity",
        limit: expectedNestedIds.length + 1,
      });
      assert.deepEqual(nestedForward.items, fullNested.visibleTurnItems);
      const messagePage = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "messages",
        limit: 2,
      });
      assert.deepEqual(
        messagePage.items,
        fullNested.visibleTurnItems
          .filter((row) =>
            ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
          )
          .slice(0, 2),
      );

      const emptyMiddleThreadId = ThreadId.make(
        "thread:projection-fork-source-rollback:empty-middle",
      );
      const emptyMiddleRunId = RunId.make("run:projection-fork-source-rollback:empty-middle");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-thread"),
        type: "thread.created",
        threadId: emptyMiddleThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyMiddleThreadId,
          projectId,
          title: "Empty middle fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRun2Id },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-run"),
        type: "run.updated",
        threadId: emptyMiddleThreadId,
        runId: emptyMiddleRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyMiddleRunId,
          threadId: emptyMiddleThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:empty-middle"),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const emptyLeafThreadId = ThreadId.make("thread:projection-fork-source-rollback:empty-leaf");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-leaf-thread"),
        type: "thread.created",
        threadId: emptyLeafThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyLeafThreadId,
          projectId,
          title: "Leaf after empty fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: emptyMiddleThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: emptyMiddleThreadId,
            runId: emptyMiddleRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const emptyMiddleSnapshot = yield* projectionStore.getThreadSnapshotWindow(
        emptyLeafThreadId,
        { rowLimit: 2 },
      );
      assert.deepEqual(
        emptyMiddleSnapshot.projection.visibleTurnItems.map((row) => [
          row.sourceThreadId,
          row.item.type,
        ]),
        [
          [sourceThreadId, "user_message"],
          [sourceThreadId, "assistant_message"],
          [sourceThreadId, "fork"],
          [emptyMiddleThreadId, "fork"],
        ],
      );

      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE run_id IN (${sourceRun1Id}, ${sourceRun2Id})
      `;
      const importedItemId = "turn-item:projection-fork-source-rollback:legacy-import";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${importedItemId}, ${sourceThreadId}, NULL, NULL, NULL, NULL, NULL, 50,
          'assistant_message', 'completed', ${nowIso}, ${encodeUnknownJsonString({
            id: importedItemId,
            threadId: sourceThreadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 50,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "assistant_message",
            messageId: MessageId.make("message:projection-fork-source-rollback:legacy-import"),
            text: "legacy import before empty fork",
            streaming: false,
            historyOrigin: "v1_import",
          })}
        )
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.historyOrigin', 'v1_import')
        WHERE thread_id = ${sourceThreadId}
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const importedEmptyBoundary = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        importedEmptyBoundary.projection.visibleTurnItems.map((row) => [
          row.visibility,
          row.sourceThreadId,
          row.item.type === "assistant_message" ? row.item.text : row.item.type,
        ]),
        [
          ["inherited", sourceThreadId, "legacy import before empty fork"],
          ["synthetic", sourceThreadId, "fork"],
          ["local", targetThreadId, "command_execution"],
          ["local", targetThreadId, "command_execution"],
        ],
      );
    }),
  );

  it.effect("hides source turns rewound before the fork from a fork's visible items", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const rewoundAt = DateTime.add(now, { minutes: 1 });
      const forkedAt = DateTime.add(now, { minutes: 2 });
      const prefix = "projection-fork-after-rewind";
      const projectId = ProjectId.make(`project:${prefix}`);
      const sourceThreadId = ThreadId.make(`thread:${prefix}:source`);
      const targetThreadId = ThreadId.make(`thread:${prefix}:target`);
      const sourceProviderThreadId = ProviderThreadId.make(`provider-thread:${prefix}:source`);
      const runIds = [1, 2, 3].map((ordinal) => RunId.make(`run:${prefix}:${ordinal}`));
      const nodeIds = [1, 2, 3].map((ordinal) => NodeId.make(`node:${prefix}:${ordinal}`));
      const threadPayload = (input: {
        readonly id: ThreadId;
        readonly forkedFrom: { type: "run"; threadId: ThreadId; runId: RunId } | null;
        readonly createdAt: DateTime.Utc;
      }) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: input.id,
        projectId,
        title: input.id,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: sourceProviderThreadId,
        lineage:
          input.forkedFrom === null
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: sourceThreadId }
            : {
                parentThreadId: sourceThreadId,
                relationshipToParent: "fork" as const,
                rootThreadId: sourceThreadId,
              },
        forkedFrom: input.forkedFrom,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const runPayload = (index: number, status: "completed" | "rolled_back") => ({
        id: runIds[index]!,
        threadId: sourceThreadId,
        ordinal: index + 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: sourceProviderThreadId,
        userMessageId: MessageId.make(`message:${prefix}:user:${index + 1}`),
        rootNodeId: nodeIds[index]!,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "rolled_back" ? rewoundAt : now,
        checkpointId: null,
        contextHandoffId: null,
      });

      yield* projectionStore.apply({
        id: EventId.make(`event:${prefix}:source-thread`),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: threadPayload({ id: sourceThreadId, forkedFrom: null, createdAt: now }),
      });
      for (const [index, text] of ["one", "two", "three"].entries()) {
        const runId = runIds[index]!;
        const nodeId = nodeIds[index]!;
        const ordinal = index + 1;
        yield* projectionStore.apply({
          id: EventId.make(`event:${prefix}:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: runPayload(index, "completed"),
        });
        for (const [offset, role] of (["user", "assistant"] as const).entries()) {
          const itemBase = {
            id: TurnItemId.make(`turn-item:${prefix}:${role}:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + offset,
            status: "completed" as const,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            messageId: MessageId.make(`message:${prefix}:${role}:${ordinal}`),
          };
          yield* projectionStore.apply({
            id: EventId.make(`event:${prefix}:${role}-item-${ordinal}`),
            type: "turn-item.updated",
            threadId: sourceThreadId,
            runId,
            nodeId,
            driver,
            occurredAt: now,
            payload:
              role === "user"
                ? {
                    ...itemBase,
                    createdBy: "user",
                    creationSource: "web",
                    type: "user_message",
                    inputIntent: "turn_start",
                    text: `prompt ${text}`,
                    attachments: [],
                  }
                : {
                    ...itemBase,
                    type: "assistant_message",
                    text: `reply ${text}`,
                    streaming: false,
                  },
          });
        }
        // Edit from here on prompt two rewinds run 2 before prompt three is sent.
        if (ordinal === 2) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${prefix}:run-2-rolled-back`),
            type: "run.updated",
            threadId: sourceThreadId,
            runId,
            nodeId,
            driver,
            occurredAt: rewoundAt,
            payload: runPayload(index, "rolled_back"),
          });
        }
      }

      const forkedFrom = { type: "run" as const, threadId: sourceThreadId, runId: runIds[2]! };
      yield* projectionStore.apply({
        id: EventId.make(`event:${prefix}:target-thread`),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: forkedAt,
        payload: threadPayload({ id: targetThreadId, forkedFrom, createdAt: forkedAt }),
      });

      const visibleTexts = (rows: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>) =>
        rows.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        );
      const source = yield* projectionStore.getThreadProjection(sourceThreadId);
      assert.deepEqual(visibleTexts(source.visibleTurnItems), [
        "prompt one",
        "reply one",
        "prompt three",
        "reply three",
      ]);
      const expected = ["prompt one", "reply one", "prompt three", "reply three", "fork"];
      const target = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(visibleTexts(target.visibleTurnItems), expected);
      const page = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
      });
      assert.deepEqual(visibleTexts(page.items), expected);
      const window = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });
      assert.deepEqual(visibleTexts(window.projection.visibleTurnItems), expected);
      assert.equal(
        (yield* projectionStore.getThreadShell(targetThreadId))?.visibleItemCount,
        expected.length,
      );
    }),
  );

  it.effect("a pull request watch keeps a finished thread working until it ends", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:watched-pull-request");
      const runId = RunId.make("run:watched-pull-request");
      const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:watched-pull-request"),
        title: "Babysit the PR",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:watched-pull-request"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const link = {
        host: "github.com",
        repository: "goat-si/goat",
        number: 7,
        url: "https://github.com/goat-si/goat/pull/7",
        source: "agent" as const,
        linkedAt: DateTime.formatIso(at),
        snapshot: null,
        stack: null,
      };
      const syncPullRequests = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
        store.apply({
          id: EventId.make(`event:watched-pull-request:${id}`),
          type: "thread.pull-request-synced",
          threadId,
          occurredAt: at,
          payload: { ...thread, pullRequests },
        });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:watched-pull-request");
      const phase = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        return shell && projectThreadAwarenessV2({ environmentId, project, thread: shell })?.phase;
      });

      yield* syncPullRequests("watched", [
        {
          ...link,
          watch: {
            startedAt: DateTime.formatIso(at),
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: DateTime.formatIso(at),
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, [
        {
          taskId: "pull-request-watch:github.com/goat-si/goat#7",
          description: "Watching pull request #7",
          kind: "monitor",
          awaited: true,
        },
      ]);
      assert.equal(yield* phase, "running");

      yield* syncPullRequests("unwatched", [link]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      assert.equal(yield* phase, "completed");
    }),
  );

  it.effect("dates a completion released by held background work at the release", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:held-completion");
      const runId = RunId.make("run:held-completion");
      const providerThreadId = ProviderThreadId.make("provider-thread:held-completion");
      const completedAt = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
      const releasedAt = DateTime.makeUnsafe("2026-09-28T12:05:00.000Z");
      const providerThread = {
        id: providerThreadId,
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
        pendingBackgroundTasks: [
          { taskId: "watch", kind: "monitor" as const, awaited: true as const },
        ],
        createdAt: completedAt,
        updatedAt: completedAt,
      };
      yield* store.apply({
        id: EventId.make("event:held-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: completedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:held-completion"),
          title: "Watch the build",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: completedAt,
          updatedAt: completedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:held-completion"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: completedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-running"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: providerThread,
      });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:held-completion");
      const held = yield* store.getThreadShell(threadId);
      assert.equal(
        held && projectThreadAwarenessV2({ environmentId, project, thread: held })?.phase,
        "running",
      );

      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-ended"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: releasedAt,
        payload: { ...providerThread, pendingBackgroundTasks: [], updatedAt: releasedAt },
      });
      const released = yield* store.getThreadShell(threadId);
      const state =
        released && projectThreadAwarenessV2({ environmentId, project, thread: released });
      assert.equal(state?.phase, "completed");
      assert.equal(state?.updatedAt, DateTime.formatIso(releasedAt));

      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-restarted"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: releasedAt,
        payload: { ...providerThread, updatedAt: releasedAt },
      });
      const newerRunId = RunId.make("run:held-completion:new-provider");
      yield* store.apply({
        id: EventId.make("event:held-completion:new-provider"),
        type: "run.created",
        threadId,
        runId: newerRunId,
        occurredAt: releasedAt,
        payload: {
          ...(yield* store.getThreadProjection(threadId)).runs[0]!,
          id: newerRunId,
          ordinal: 2,
          providerThreadId: ProviderThreadId.make("provider-thread:held-completion:new-provider"),
          requestedAt: releasedAt,
          startedAt: releasedAt,
          completedAt: releasedAt,
        },
      });
      const { statements, tracer } = traceSqlStatements();
      assert.deepEqual(
        (yield* store
          .getRuntimeRecoveryProjection(threadId)
          .pipe(Effect.withTracer(tracer))).runs.map((run) => run.id),
        [runId, newerRunId],
      );
      const sql = yield* SqlClient.SqlClient;
      const itemReads = statements.filter((query) => query.includes("turn_items"));
      assert.isAbove(itemReads.length, 0);
      for (const statement of itemReads) {
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        );
        for (const { detail } of plan) {
          assert.notMatch(detail, /turn_items_(thread_ordinal|thread_run)_idx \(thread_id=\?\)$/);
        }
      }
    }),
  );

  it.effect("returns a typed read error for malformed stored plan JSON", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("corrupt-plan");
      const planId = PlanId.make("plan:corrupt");
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, node_id, kind, status, payload_json)
        VALUES (${planId}, ${threadId}, 'node:corrupt-plan', 'proposed_plan', 'active', '{broken')`;

      const failure = yield* store
        .getPlan(threadId, planId)
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.orDie(
              sql`DELETE FROM orchestration_v2_projection_plans WHERE plan_id = ${planId}`,
            ),
          ),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );
});
