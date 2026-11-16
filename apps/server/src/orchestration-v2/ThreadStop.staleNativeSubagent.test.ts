import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { createWatchingThread, delegate, layerTest, send } from "./ThreadStop.testkit.ts";

// A finished delegated child whose native subagent the provider never reported ending,
// with no open turn item, and a nested native subagent on that agent's own thread.
it.effect(
  "Stop settles a delegated row whose finished child still records a running native subagent",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const parentThreadId = ThreadId.make("thread:held-row");
      yield* createWatchingThread(parentThreadId, 30);
      yield* send(parentThreadId, "parent", "start_immediately");
      const childThreadId = yield* delegate(parentThreadId, "held child");
      const child = yield* orchestrator.getThreadProjection(childThreadId);
      const childRun = child.runs[0]!;
      const task = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!;
      const now = yield* DateTime.now;
      const nativeThreadId = ThreadId.make("thread:held-row-native");
      const nestedThreadId = ThreadId.make("thread:held-row-nested");
      yield* createWatchingThread(nativeThreadId, 31);
      yield* createWatchingThread(nestedThreadId, 32);
      const nativeProviderThreadId = ProviderThreadId.make("provider-thread:held-row-native");
      const runningRoot = (threadId: ThreadId, id: NodeId) => ({
        ...child.nodes.find((node) => node.id === childRun.rootNodeId)!,
        id,
        rootNodeId: id,
        threadId,
        runId: null,
        parentNodeId: null,
        status: "running" as const,
        countsForRun: false,
        completedAt: null,
      });
      const nativeRoot = runningRoot(nativeThreadId, NodeId.make("node:held-row-native-root"));
      const nestedRoot = runningRoot(nestedThreadId, NodeId.make("node:held-row-nested-root"));
      for (const root of [nativeRoot, nestedRoot]) {
        yield* projections.apply({
          id: EventId.make(`event:held-row:${root.id}`),
          type: "node.updated",
          threadId: root.threadId,
          nodeId: root.id,
          occurredAt: now,
          payload: root,
        });
      }
      yield* projections.apply({
        id: EventId.make("event:held-row:native-turn"),
        type: "provider-turn.updated",
        threadId: nativeThreadId,
        nodeId: nativeRoot.id,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make("turn:held-row-native"),
          providerThreadId: nativeProviderThreadId,
          nodeId: nativeRoot.id,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal: 1,
          status: "running",
          startedAt: now,
          completedAt: null,
        },
      });
      const native = {
        ...task,
        id: NodeId.make("node:held-row-native"),
        threadId: childThreadId,
        runId: childRun.id,
        parentNodeId: childRun.rootNodeId!,
        origin: "provider_native" as const,
        providerThreadId: nativeProviderThreadId,
        childThreadId: nativeThreadId,
        status: "running" as const,
        completionDelivery: undefined,
      };
      yield* projections.apply({
        id: EventId.make("event:held-row:native"),
        type: "subagent.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: native,
      });
      yield* projections.apply({
        id: EventId.make("event:held-row:nested"),
        type: "subagent.updated",
        threadId: nativeThreadId,
        occurredAt: now,
        payload: {
          ...native,
          id: NodeId.make("node:held-row-nested"),
          threadId: nativeThreadId,
          runId: null,
          parentNodeId: nativeRoot.id,
          childThreadId: nestedThreadId,
        },
      });
      yield* projections.apply({
        id: EventId.make("event:held-row:child-completed"),
        type: "run.updated",
        threadId: childThreadId,
        runId: childRun.id,
        occurredAt: now,
        payload: { ...childRun, status: "completed", startedAt: now, completedAt: now },
      });
      yield* orchestrator.recoverDelegatedTasks;
      assert.equal(
        (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]?.status,
        "running",
      );
      const statuses = Effect.gen(function* () {
        const nativeAfter = yield* orchestrator.getThreadProjection(nativeThreadId);
        const nestedAfter = yield* orchestrator.getThreadProjection(nestedThreadId);
        return {
          row: (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]?.status,
          native: (yield* orchestrator.getThreadProjection(childThreadId)).subagents.find(
            (subagent) => subagent.id === native.id,
          )?.status,
          nativeRoot: nativeAfter.nodes.find((node) => node.id === nativeRoot.id)?.status,
          nested: nativeAfter.subagents[0]?.status,
          nestedRoot: nestedAfter.nodes.find((node) => node.id === nestedRoot.id)?.status,
        };
      });

      // The row's Stop: the parent's task, then the child thread.
      yield* orchestrator.dispatch({
        type: "subagent.stop",
        commandId: CommandId.make("held-row:stop-task"),
        threadId: parentThreadId,
        runId: task.runId!,
        subagentId: task.id,
      });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("held-row:stop-child"),
        threadId: childThreadId,
      });
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.deepEqual(yield* statuses, {
        row: "completed",
        native: "interrupted",
        nativeRoot: "interrupted",
        nested: "interrupted",
        nestedRoot: "interrupted",
      });
    }).pipe(Effect.provide(layerTest)),
);
