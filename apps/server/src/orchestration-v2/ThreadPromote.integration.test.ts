import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, so only commands change them.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase)),
      ServerSettings.layerTest(),
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-promote" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:thread-promote"),
      title: `Title of ${threadId}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** Delegates `task` from the parent's latest run and returns the child thread. */
const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

/** A parent whose turn delegated `task`, which in turn delegated a grandchild. */
const delegatedTree = (name: string) =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make(`thread:${name}`);
    yield* createThread(parentThreadId);
    yield* send(parentThreadId, "orchestrate");
    const childThreadId = yield* delegate(parentThreadId, `${name} task`);
    const grandchildThreadId = yield* delegate(childThreadId, `${name} grandchild`);
    return { parentThreadId, childThreadId, grandchildThreadId };
  });

const promote = (threadId: ThreadId, commandId: string) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return yield* threads.dispatch({
      type: "thread.promote",
      commandId: CommandId.make(commandId),
      threadId,
    });
  });

const runStatuses = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status);
  });

const taskOf = (parentThreadId: ThreadId, childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((task) => task.childThreadId === childThreadId)!;
  });

it.effect("promoting a running delegated task detaches its thread and ends the task", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId, grandchildThreadId } = yield* delegatedTree("promote");
    const childRunsBefore = yield* runStatuses(childThreadId);

    yield* promote(childThreadId, "promote-child");

    const child = (yield* orchestrator.getThreadProjection(childThreadId)).thread;
    assert.deepEqual(child.lineage, {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: childThreadId,
    });
    assert.deepEqual(child.launchedBy, {
      kind: "promotion",
      threadId: parentThreadId,
      environmentId: null,
      environmentLabel: null,
      threadTitle: `Title of ${parentThreadId}`,
    });
    // The child keeps its history and its running work.
    assert.deepEqual(yield* runStatuses(childThreadId), childRunsBefore);
    const shell = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadShell(childThreadId);
    assert.deepEqual(shell?.launchedBy, child.launchedBy);

    const task = yield* taskOf(parentThreadId, childThreadId);
    assert.equal(task.status, "cancelled");
    assert.isDefined(task.promotedAt);
    assert.include(task.result ?? "", "Promoted to top-level thread");
    assert.notEqual(task.completionDelivery?.state, "disposed");
    // The child's own delegate is still its child.
    const grandchild = (yield* orchestrator.getThreadProjection(grandchildThreadId)).thread;
    assert.equal(grandchild.lineage.parentThreadId, childThreadId);
    assert.deepEqual(grandchild.launchedBy, {
      kind: "launch",
      threadId: childThreadId,
      environmentId: null,
      environmentLabel: null,
      threadTitle: child.title,
      via: "delegate_task",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("promotion is a no-op on retry and refused for threads that are not delegated", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId } = yield* delegatedTree("promote-retry");
    yield* promote(childThreadId, "promote-retry-1");
    const before = (yield* orchestrator.getThreadProjection(childThreadId)).thread;
    const taskBefore = yield* taskOf(parentThreadId, childThreadId);

    const retried = yield* promote(childThreadId, "promote-retry-2");
    assert.lengthOf(retried.storedEvents, 1);
    assert.deepEqual((yield* orchestrator.getThreadProjection(childThreadId)).thread, before);
    assert.deepEqual(yield* taskOf(parentThreadId, childThreadId), taskBefore);

    const refused = yield* Effect.exit(promote(parentThreadId, "promote-top-level"));
    assert.isTrue(Exit.isFailure(refused));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stops from the former parent no longer reach a promoted thread or its delegates", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { parentThreadId, childThreadId, grandchildThreadId } =
      yield* delegatedTree("promote-stop");
    // A cascade that read the tree before the promotion, delivered after it.
    yield* promote(childThreadId, "promote-stop");
    for (const threadId of [childThreadId, grandchildThreadId]) {
      const stale = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`stale-stop:${threadId}`),
        threadId,
        stopCascadeFrom: parentThreadId,
      });
      assert.lengthOf(stale.storedEvents, 0);
    }
    // A cascade that starts after the promotion skips the promoted task entirely.
    yield* threads.stopDelegatedTasks({
      threadId: parentThreadId,
      commandId: CommandId.make("stop-parent-tasks"),
    });
    assert.notInclude(yield* runStatuses(childThreadId), "interrupted");
    assert.notInclude(yield* runStatuses(grandchildThreadId), "interrupted");

    // The promoted thread's own Stop still reaches its delegate.
    yield* threads.stopDelegatedTasks({
      threadId: childThreadId,
      commandId: CommandId.make("stop-child-tasks"),
    });
    assert.include(yield* runStatuses(grandchildThreadId), "interrupted");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a cascade that promotion overtakes mid-walk leaves the promoted subtree running", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId, grandchildThreadId } =
      yield* delegatedTree("promote-race");
    let promoted = false;
    const stopDelegatedTasks = ThreadManagementService.makeStopDelegatedTasks({
      getThreadRecords: orchestrator.getThreadRecords,
      // The walk has already read the parent's tasks when the user promotes the child.
      dispatch: (command) =>
        Effect.gen(function* () {
          if (!promoted) {
            promoted = true;
            yield* orchestrator.dispatch({
              type: "thread.promote",
              commandId: CommandId.make("promote-race"),
              threadId: childThreadId,
            });
          }
          return yield* orchestrator.dispatch(command);
        }).pipe(Effect.orDie),
    });
    yield* stopDelegatedTasks({
      threadId: parentThreadId,
      commandId: CommandId.make("stop-race"),
    });
    assert.isTrue(promoted);
    assert.notInclude(yield* runStatuses(childThreadId), "interrupted");
    assert.notInclude(yield* runStatuses(grandchildThreadId), "interrupted");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a finished task keeps its result, and later disposal keeps the promotion notice", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { parentThreadId, childThreadId } = yield* delegatedTree("promote-finished");
    const task = yield* taskOf(parentThreadId, childThreadId);
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:promote-finished:task-completed"),
      type: "subagent.updated",
      threadId: parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      occurredAt: now,
      payload: { ...task, status: "completed", result: "done", completedAt: now },
    });

    yield* promote(childThreadId, "promote-finished");
    const promotedTask = yield* taskOf(parentThreadId, childThreadId);
    assert.equal(promotedTask.status, "completed");
    assert.equal(promotedTask.result, "done");
    assert.isDefined(promotedTask.promotedAt);

    // A task_cancel that read the task before the promotion disposes its delivery after it.
    yield* orchestrator.dispatch({
      type: "delegated_task.completion-delivery.dispose",
      commandId: CommandId.make("dispose-after-promotion"),
      parentThreadId,
      taskId: task.id,
    });
    assert.deepEqual(
      (yield* taskOf(parentThreadId, childThreadId)).completionDelivery,
      promotedTask.completionDelivery,
    );
  }).pipe(Effect.provide(layerTest)),
);

// Same harness with a continuation queue the test can read: a promotion that ends a
// running task must actually offer the parent its wake.
const layerWithContinuations = layerTest.pipe(
  Layer.provideMerge(ProviderContinuationRequests.layer),
);

it.effect("promotion offers the former parent a wake for the task it ended", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const { parentThreadId, childThreadId } = yield* delegatedTree("promote-wake");
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    const providerThreadId = ProviderThreadId.make("provider-thread:promote-wake");
    const driver = ProviderDriverKind.make("codex");
    const now = yield* DateTime.now;
    // The parent's turn ran on a provider thread and has ended, so the async task's
    // result can only reach it through a wake.
    yield* projections.apply({
      id: EventId.make("event:promote-wake:provider-thread"),
      type: "provider-thread.updated",
      threadId: parentThreadId,
      driver,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: providerThreadId,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: parentThreadId,
        ownerNodeId: parentRun.rootNodeId!,
        nativeThreadRef: { driver, nativeId: "native:promote-wake", strength: "strong" },
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
    yield* projections.apply({
      id: EventId.make("event:promote-wake:parent-run-completed"),
      type: "run.updated",
      threadId: parentThreadId,
      runId: parentRun.id,
      occurredAt: now,
      payload: { ...parentRun, providerThreadId, status: "completed", completedAt: now },
    });

    yield* promote(childThreadId, "promote-wake");

    const task = yield* taskOf(parentThreadId, childThreadId);
    const run = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
      (candidate) => candidate.id === parentRun.id,
    )!;
    assert.include(run.delegatedCompletion?.delivery?.taskIds ?? [], task.id);
    const wake = yield* requests.take;
    assert.equal(wake.threadId, parentThreadId);
    assert.equal(wake.providerThreadId, providerThreadId);
    assert.equal(wake.delegatedCompletion?.parentRunId, parentRun.id);
  }).pipe(Effect.provide(layerWithContinuations)),
);
