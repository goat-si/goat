import { assert } from "@effect/vitest";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  TurnItemId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
export const createThread = Effect.fn(function* (
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

export const createRun = Effect.fn(function* (
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

const driver = ProviderDriverKind.make("codex");

export const settledParentRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
  type ParentState = "settled" | "archived" | "deleted" | null;
  const threadPayload = (threadId: ThreadId, parentThreadId: ThreadId | null, state: ParentState) =>
    ({
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:settled-parent-limit"),
      title: "Settled parent limit recovery",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId,
        relationshipToParent: parentThreadId === null ? null : "subagent",
        rootThreadId: parentThreadId ?? threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: state === "archived" ? now : null,
      settledOverride: state === "settled" ? ("settled" as const) : null,
      settledAt: state === "settled" ? now : null,
      lastVisitedAt: null,
      deletedAt: state === "deleted" ? now : null,
    }) as const;
  const createThread = (threadId: ThreadId, parentThreadId: ThreadId | null, state: ParentState) =>
    store.apply({
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: threadPayload(threadId, parentThreadId, state),
    });
  const addLimitedChild = Effect.fnUntraced(function* (name: string, parentState: ParentState) {
    const parentId = ThreadId.make(`thread:settled-parent-limit:${name}:parent`);
    const childId = ThreadId.make(`thread:settled-parent-limit:${name}:child`);
    const runId = RunId.make(`run:settled-parent-limit:${name}`);
    const rootNodeId = NodeId.make(`node:settled-parent-limit:${name}`);
    yield* createThread(parentId, null, parentState);
    yield* createThread(childId, parentId, null);
    const run = {
      id: runId,
      threadId: childId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:settled-parent-limit:${name}`),
      rootNodeId,
      activeAttemptId: null,
      status: "failed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    };
    yield* store.apply({
      id: EventId.make(`event:settled-parent-limit:${name}:run`),
      type: "run.created",
      threadId: childId,
      runId,
      nodeId: rootNodeId,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: run,
    });
    yield* store.apply({
      id: EventId.make(`event:settled-parent-limit:${name}:error`),
      type: "turn-item.updated",
      threadId: childId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:settled-parent-limit:${name}:error`),
        threadId: childId,
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
        failure: {
          class: "usage_limit",
          message: "Plan limit reached.",
          resetAt,
          code: "usageLimitExceeded",
          retryable: null,
        },
      },
    });
    return childId;
  });
  const settledParentChild = yield* addLimitedChild("settled", "settled");
  const archivedParentChild = yield* addLimitedChild("archived", "archived");
  const deletedParentChild = yield* addLimitedChild("deleted", "deleted");
  const activeParentChild = yield* addLimitedChild("active", null);
  const children = [settledParentChild, archivedParentChild, deletedParentChild, activeParentChild];
  for (const options of [
    { now, autoResume: true, snooze: false },
    { now, autoResume: false, snooze: true },
  ]) {
    const armed = (yield* store.getLimitRecoveryCandidates(options))
      .filter((row) => children.includes(row.id))
      .filter(
        (row) =>
          limitRecoveryCommand(row, options.autoResume, DateTime.toEpochMillis(now), options.snooze)
            ?.type === "thread.metadata.update",
      )
      .map((row) => row.id);
    assert.deepEqual(armed, [activeParentChild], "only the child of the open parent is armed");
  }
  // A recovery armed before the parent settled still resumes at its reset.
  yield* store.apply({
    id: EventId.make("event:settled-parent-limit:settled:armed"),
    type: "thread.metadata-updated",
    threadId: settledParentChild,
    occurredAt: now,
    payload: {
      ...threadPayload(
        settledParentChild,
        ThreadId.make("thread:settled-parent-limit:settled:parent"),
        null,
      ),
      limitRecovery: {
        runId: RunId.make("run:settled-parent-limit:settled"),
        resetAt,
        autoResume: true,
      },
    },
  });
  const afterReset = DateTime.add(now, { hours: 2 });
  const resumed = (yield* store.getLimitRecoveryCandidates({
    now: afterReset,
    autoResume: true,
    snooze: false,
  })).find((row) => row.id === settledParentChild);
  assert.isDefined(resumed);
  assert.isTrue(
    limitRecoveryCommand(
      resumed,
      true,
      DateTime.toEpochMillis(afterReset),
      false,
    )?.commandId.startsWith("limit-resume:"),
  );
});
