import {
  CommandId,
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { createWatchingThread, delegate, send } from "./ThreadStop.testkit.ts";

const required = <A>(value: A | null | undefined, what: string): A => {
  if (value === null || value === undefined) throw new Error(`Missing test fixture: ${what}`);
  return value;
};

/** Puts the thread's first run mid-turn with a Stop request, flagged unanswered when asked. */
export const stopRequested = (threadId: ThreadId, unanswered: boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const started = yield* orchestrator.getThreadProjection(threadId);
    const run = required(started.runs[0], "the run");
    const attempt = required(
      started.attempts.find((candidate) => candidate.runId === run.id),
      "the run attempt",
    );
    const providerThreadId = required(run.providerThreadId, "the provider thread");
    const rootNodeId = required(run.rootNodeId, "the root node");
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
        nodeId: rootNodeId,
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
        nodeId: rootNodeId,
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
export const parentWithTask = (name: string, stop: "none" | "requested" | "unanswered") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make(`thread:${name}`);
    yield* createWatchingThread(parentThreadId, 40);
    yield* send(parentThreadId, "plan", "start_immediately");
    const childThreadId = yield* delegate(parentThreadId, `${name} task`);
    if (stop !== "none") yield* stopRequested(childThreadId, stop === "unanswered");
    const parent = yield* orchestrator.getThreadProjection(parentThreadId);
    const taskId = required(
      parent.subagents.find((task) => task.childThreadId === childThreadId),
      "the task",
    ).id;
    return { parentThreadId, childThreadId, taskId };
  });

export const runStatuses = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return (yield* orchestrator.getThreadProjection(threadId)).runs.map((run) => run.status);
  });

export const refusal = (input: { parentThreadId: ThreadId; taskId: NodeId }) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(threads.forceStopDelegatedTask(input));
    return error._tag === "DelegatedForceStopRefused"
      ? error.reason
      : error._tag === "OrchestrationV2ForceStopThreadError"
        ? (error.reason ?? error._tag)
        : error._tag;
  });

/** Rewrites the child's provider thread, as its provider boundary would. */
export const updateChildProviderThread = (
  childThreadId: ThreadId,
  patch: (
    thread: OrchestrationV2ProviderThread,
    now: DateTime.Utc,
  ) => OrchestrationV2ProviderThread,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const providerThread = required(
      (yield* orchestrator.getThreadProjection(childThreadId)).providerThreads[0],
      "the provider thread",
    );
    yield* projections.apply({
      id: EventId.make(`event:${childThreadId}:provider-thread`),
      type: "provider-thread.updated",
      threadId: childThreadId,
      occurredAt: now,
      payload: patch(providerThread, now),
    });
  });

export const interruptResult = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const item = (yield* orchestrator.getThreadProjection(threadId)).turnItems.find(
      (candidate) => candidate.type === "run_interrupt_result",
    );
    return item?.type === "run_interrupt_result" ? item.message : undefined;
  });

/** Rewrites the parent's record of a task, as a promotion or a provider-native report would. */
export const updateTask = (
  parentThreadId: ThreadId,
  taskId: NodeId,
  patch: (task: OrchestrationV2Subagent, now: DateTime.Utc) => OrchestrationV2Subagent,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const task = required(
      (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (candidate) => candidate.id === taskId,
      ),
      "the task",
    );
    yield* projections.apply({
      id: EventId.make(`event:${parentThreadId}:task-patch`),
      type: "subagent.updated",
      threadId: parentThreadId,
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: patch(task, now),
    });
  });
