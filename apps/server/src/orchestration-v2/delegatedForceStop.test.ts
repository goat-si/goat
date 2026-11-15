import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { createWatchingThread, delegate, layerTest, send } from "./ThreadStop.testkit.ts";

/** Puts the thread's first run mid-turn with a Stop request, flagged unanswered when asked. */
const stopRequested = (threadId: ThreadId, unanswered: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const started = yield* orchestrator.getThreadProjection(threadId);
    const run = started.runs[0]!;
    const attempt = started.attempts.find((candidate) => candidate.runId === run.id)!;
    const providerThreadId = run.providerThreadId!;
    const providerTurnId = ProviderTurnId.make(`provider-turn:${threadId}`);
    const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "threadId">) =>
      projections.apply({
        ...event,
        id: EventId.make(`event:${threadId}:${event.type}`),
        threadId,
      } as OrchestrationV2DomainEvent);
    yield* apply({
      type: "run.updated",
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now, activeAttemptId: attempt.id },
    });
    yield* apply({
      type: "run-attempt.updated",
      occurredAt: now,
      payload: { ...attempt, status: "running", startedAt: now },
    });
    yield* apply({
      type: "provider-turn.updated",
      occurredAt: now,
      payload: {
        id: providerTurnId,
        providerThreadId,
        nodeId: run.rootNodeId!,
        runAttemptId: attempt.id,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    yield* apply({
      type: "turn-item.updated",
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:${threadId}:interrupt-request`),
        threadId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1_000,
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: "Cancelled by the parent",
      },
    });
    if (unanswered)
      yield* orchestrator.dispatch({
        type: "thread.interrupt.unresponsive",
        commandId: CommandId.make(`unresponsive:${threadId}`),
        threadId,
        providerThreadId,
        providerTurnId,
      });
  });

/** A parent mid-run with one delegated task whose child run is running. */
const parentWithTask = (name: string, stop: "none" | "requested" | "unanswered") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make(`thread:${name}`);
    yield* createWatchingThread(parentThreadId, 40);
    yield* send(parentThreadId, "plan", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, `${name} task`);
    if (stop !== "none") yield* stopRequested(childThreadId, stop === "unanswered");
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const taskId = parent.subagents.find((task) => task.childThreadId === childThreadId)!.id;
    return { parentThreadId, childThreadId, taskId };
  });

const runStatuses = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status);
  });

const refusal = (input: { parentThreadId: ThreadId; taskId: NodeId }) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(threads.forceStopDelegatedTask(input));
    return error._tag === "DelegatedForceStopRefused" ? error.reason : error._tag;
  });

it.effect("the parent's Force stop ends its task's child after Stop went unanswered", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId, taskId } = yield* parentWithTask(
      "force-ok",
      "unanswered",
    );
    const forced = yield* threads.forceStopDelegatedTask({ parentThreadId, taskId });
    assert.equal(forced.childThreadId, childThreadId);
    assert.deepEqual(yield* runStatuses(childThreadId), ["interrupted"]);
    const result = (yield* orchestrator.getThreadProjection(childThreadId)).turnItems.find(
      (item) => item.type === "run_interrupt_result",
    );
    // The child's timeline names who force stopped it.
    assert.equal(
      result?.type === "run_interrupt_result" ? result.message : undefined,
      `Force stopped by parent thread "${parentThreadId}" (${parentThreadId})`,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a first Force stop, before any Stop timed out, refuses and stops nothing", () =>
  Effect.gen(function* () {
    const { parentThreadId, childThreadId, taskId } = yield* parentWithTask(
      "force-early",
      "requested",
    );
    assert.equal(yield* refusal({ parentThreadId, taskId }), "not_unresponsive");
    assert.deepEqual(yield* runStatuses(childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("only the thread that created the task can force stop it", () =>
  Effect.gen(function* () {
    const { childThreadId, taskId } = yield* parentWithTask("force-owner", "unanswered");
    // Another parent's task, and a top-level thread that no task of this thread names.
    const other = yield* parentWithTask("force-other", "unanswered");
    assert.equal(yield* refusal({ parentThreadId: other.parentThreadId, taskId }), "not_owner");
    assert.equal(
      yield* refusal({
        parentThreadId: other.parentThreadId,
        taskId: NodeId.make(String(childThreadId)),
      }),
      "not_owner",
    );
    assert.deepEqual(yield* runStatuses(childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a grandchild is not its grandparent's to force stop", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { parentThreadId, childThreadId } = yield* parentWithTask("force-grand", "none");
    const grandchildThreadId = yield* delegate(childThreadId, "force-grand nested");
    yield* stopRequested(grandchildThreadId, true);
    const grandTaskId = (yield* orchestrator.getThreadProjection(childThreadId)).subagents.find(
      (task) => task.childThreadId === grandchildThreadId,
    )!.id;
    assert.equal(yield* refusal({ parentThreadId, taskId: grandTaskId }), "not_owner");
    assert.deepEqual(yield* runStatuses(grandchildThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);
