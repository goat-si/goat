import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ServerCommand,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Ref from "effect/Ref";

import type {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

/** Bounds the lineage walk of a Stop cascade; delegation never nests this deep. */
const MAX_DELEGATION_DEPTH = 64;

type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;

/**
 * The Orchestrator closures that promotion needs. The Orchestrator passes its
 * error classes in so this module never imports it at runtime.
 */
/** A delegated task its parent still owns: started by the app and not promoted to a thread. */
export const isOwnedDelegatedTask = (task: {
  readonly origin: string;
  readonly childThreadId: unknown;
  readonly promotedAt?: unknown;
}): boolean =>
  task.origin === "app_owned" && task.childThreadId !== null && task.promotedAt === undefined;

export interface ThreadPromotionDeps {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly emit: (
    events: Events,
    command: OrchestrationV2ServerCommand,
  ) => <Event extends OrchestrationV2DomainEvent>(
    event: Omit<Event, "id">,
  ) => Effect.Effect<Event, OrchestratorV2Error>;
  readonly readCommandProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getProjectionWithPendingEvents: (
    threadId: ThreadId,
    events: Events,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly planDelegatedCompletionDelivery: (input: {
    readonly parentProjection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "messages" | "runs" | "subagents" | "providerTurns"
    >;
    readonly parentRun: OrchestrationV2Run | undefined;
    readonly task: OrchestrationV2Subagent;
    readonly updatedTask: OrchestrationV2Subagent;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<
    {
      readonly task: OrchestrationV2Subagent;
      readonly parentRun: OrchestrationV2Run | undefined;
      readonly message: OrchestrationV2ConversationMessage | undefined;
    },
    OrchestratorV2Error
  >;
  readonly isTerminalDelegatedTaskStatus: (status: OrchestrationV2Subagent["status"]) => boolean;
  readonly OrchestratorDispatchError: typeof OrchestratorDispatchError;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/**
 * Promoting a delegated task's thread to a top-level thread, and the lineage check
 * that keeps a Stop cascade from reaching a promoted thread. Neither has its own span:
 * the dispatch and Stop spans cover them.
 */
export const makeThreadPromotion = (deps: ThreadPromotionDeps) => {
  const {
    projectionStore,
    emit,
    readCommandProjection,
    getProjectionWithPendingEvents,
    planDelegatedCompletionDelivery,
    isTerminalDelegatedTaskStatus,
    OrchestratorDispatchError,
    OrchestratorProjectionError,
  } = deps;

  /**
   * Whether `thread` is still delegated, through any number of subagent links, under
   * `ancestorId`. Lineage only ever detaches, so committed reads of the chain suffice.
   */
  const isDelegatedDescendantOf = Effect.fnUntraced(function* (
    thread: OrchestrationV2AppThread,
    ancestorId: ThreadId,
  ) {
    let current = thread;
    for (let depth = 0; depth < MAX_DELEGATION_DEPTH; depth += 1) {
      const parentId = current.lineage.parentThreadId;
      if (current.lineage.relationshipToParent !== "subagent" || parentId === null) return false;
      if (parentId === ancestorId) return true;
      const parent = yield* Effect.option(projectionStore.getThread(parentId));
      if (Option.isNone(parent)) return false;
      current = parent.value;
    }
    return false;
  });

  /**
   * Detaches a delegated task's child thread into a top-level thread. The child keeps its
   * id, history and running work. Every app-owned task on the parent that points at it is
   * marked promoted, so stops and cancellations from the parent no longer reach it, and a
   * task still running ends as cancelled so the parent is woken like for any finished task.
   */
  const dispatchThreadPromote = Effect.fnUntraced(function* (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.promote" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const reject = (cause: string) =>
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause,
      });
    const child = yield* projectionStore
      .getThread(command.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (child.deletedAt !== null) return yield* reject(`Thread ${child.id} is deleted.`);
    const emitEvent = emit(events, command);
    const now = yield* DateTime.now;
    if (child.lineage.relationshipToParent === null && child.launchedBy?.kind === "promotion") {
      // A retry after the promotion landed: record the unchanged thread.
      yield* emitEvent({
        type: "thread.metadata-updated",
        threadId: child.id,
        providerInstanceId: child.providerInstanceId,
        occurredAt: now,
        payload: child,
      });
      return;
    }
    const parentThreadId = child.lineage.parentThreadId;
    if (
      child.lineage.relationshipToParent !== "subagent" ||
      parentThreadId === null ||
      child.forkedFrom?.type !== "node"
    ) {
      return yield* reject("Only delegated tasks can be promoted.");
    }
    const parent = yield* readCommandProjection(parentThreadId);
    const tasks = parent.subagents.filter(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId === child.id &&
        task.promotedAt === undefined,
    );
    if (tasks.length === 0) return yield* reject("Only delegated tasks can be promoted.");
    const subagentItems = yield* projectionStore
      .getThreadRecords(parentThreadId, ["turnItems"], { turnItemTypes: ["subagent"] })
      .pipe(
        Effect.map((records) => records.turnItems),
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: parentThreadId, cause }),
        ),
      );

    yield* emitEvent({
      type: "thread.metadata-updated",
      threadId: child.id,
      providerInstanceId: child.providerInstanceId,
      occurredAt: now,
      payload: {
        ...child,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: child.id },
        launchedBy: {
          kind: "promotion",
          threadId: parentThreadId,
          environmentId: null,
          environmentLabel: null,
          threadTitle: parent.thread.title,
        },
        updatedAt: now,
      },
    });

    const result = `Promoted to top-level thread ${child.id} by the user; it no longer reports to this thread.`;
    for (const task of tasks) {
      if (isTerminalDelegatedTaskStatus(task.status)) {
        yield* emitEvent({
          type: "subagent.updated",
          threadId: parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: { ...task, promotedAt: now, updatedAt: now },
        });
        continue;
      }
      // Tasks of one parent run share its completion cohort, so plan each against
      // the events already written for the previous ones.
      const current = yield* getProjectionWithPendingEvents(parentThreadId, events);
      const parentRun =
        task.runId === null ? undefined : current.runs.find((run) => run.id === task.runId);
      const plan = yield* planDelegatedCompletionDelivery({
        parentProjection: current,
        parentRun,
        task,
        updatedTask: {
          ...task,
          status: "cancelled",
          result,
          promotedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        now,
      });
      yield* emitEvent({
        type: "subagent.updated",
        threadId: parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: plan.task,
      });
      if (plan.parentRun !== undefined) {
        yield* emitEvent({
          type: "run.updated",
          threadId: parentThreadId,
          runId: plan.parentRun.id,
          ...(plan.parentRun.rootNodeId === null ? {} : { nodeId: plan.parentRun.rootNodeId }),
          providerInstanceId: plan.parentRun.providerInstanceId,
          occurredAt: now,
          payload: plan.parentRun,
        });
      }
      if (plan.message !== undefined) {
        yield* emitEvent({
          type: "message.updated",
          threadId: parentThreadId,
          ...(plan.message.runId === null ? {} : { runId: plan.message.runId }),
          ...(plan.message.nodeId === null ? {} : { nodeId: plan.message.nodeId }),
          providerInstanceId:
            plan.parentRun?.providerInstanceId ?? parent.thread.providerInstanceId,
          occurredAt: now,
          payload: plan.message,
        });
      }
      const node = current.nodes.find((candidate) => candidate.id === task.id);
      if (node !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: parentThreadId,
          ...(node.runId === null ? {} : { runId: node.runId }),
          nodeId: node.id,
          driver: task.driver,
          occurredAt: now,
          payload: { ...node, status: "cancelled", completedAt: now },
        });
      }
      const item = subagentItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
      );
      if (item !== undefined) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: parentThreadId,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          driver: task.driver,
          occurredAt: now,
          payload: { ...item, status: "cancelled", result, completedAt: now, updatedAt: now },
        });
      }
    }
  });

  return { isDelegatedDescendantOf, dispatchThreadPromote };
};
