import * as LatestAnswer from "./ProjectionLatestAnswer.ts";
import * as RunNotification from "./ProjectionRunNotification.ts";
import { applyThreadPullRequestLinkUpdate } from "../sourceControl/threadPullRequests.ts";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ProviderThreadId,
} from "@goat/contracts";
import { ThreadId, ProviderInstanceId } from "@goat/contracts";
import {
  isIdleCompactionRun,
  notificationCursorContext,
  withLocalVisibleTurnItems,
} from "./threadShellProjection.ts";

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  const updated = [...items];
  updated[index] = next;
  return updated;
}

export function upsertProviderTurn(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  next: OrchestrationV2ProviderTurn,
): Array<OrchestrationV2ProviderTurn> {
  const current = turns.find((turn) => turn.id === next.id);
  return upsertById(turns, {
    ...next,
    ...((next.tokenUsage ?? current?.tokenUsage) === undefined
      ? {}
      : { tokenUsage: next.tokenUsage ?? current?.tokenUsage }),
  });
}

function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  next = RunNotification.preserveRunNotification(current, next);
  if (current === undefined) return next;
  return {
    ...next,
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
  };
}

function preserveCompletionDelivery(
  current: OrchestrationV2Subagent | undefined,
  next: OrchestrationV2Subagent,
): OrchestrationV2Subagent {
  return {
    ...next,
    ...(next.completionDelivery === undefined && current?.completionDelivery !== undefined
      ? { completionDelivery: current.completionDelivery }
      : {}),
    ...(next.reviewLedger === undefined && current?.reviewLedger !== undefined
      ? { reviewLedger: current.reviewLedger }
      : {}),
  };
}

export function emptyProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return {
    thread: LatestAnswer.withExcerpt(
      RunNotification.preserveThreadNotification(undefined, event.payload),
      undefined,
    ),
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: event.occurredAt,
  };
}

export function isQueuedProviderThreadPlaceholder(
  providerThread: OrchestrationV2ProviderThread,
): boolean {
  return (
    providerThread.status === "not_loaded" &&
    providerThread.firstRunOrdinal === null &&
    providerThread.nativeThreadRef === null &&
    providerThread.providerSessionId === null
  );
}

export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
  options?: { readonly deferNotificationCursor?: boolean },
): OrchestrationV2ThreadProjection;
export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection;
export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
  options: { readonly deferNotificationCursor?: boolean } = {},
): OrchestrationV2ThreadProjection {
  const next = applyToProjectionEvent(projection, event);
  const cursorContext = notificationCursorContext(next, [event]);
  const completedAt = options.deferNotificationCursor
    ? undefined
    : RunNotification.notificationCompletions([event], cursorContext).get(event.threadId);
  const thread = LatestAnswer.withExcerpt(
    RunNotification.preserveThreadNotification(projection.thread, next.thread),
    LatestAnswer.changesLatestAnswer(event, LatestAnswer.promptOfCompletedRunIn(projection))
      ? LatestAnswer.latestAnswerExcerpt(next, (run) => isIdleCompactionRun(run, next))
      : projection.thread.latestAnswerExcerpt,
  );
  return {
    ...next,
    thread:
      completedAt === undefined
        ? thread
        : RunNotification.advanceNotificationCursor(thread, completedAt),
  };
}

function applyToProjectionEvent(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  const base = {
    ...projection,
    thread: {
      ...projection.thread,
      updatedAt: event.occurredAt,
    },
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "thread.pull-request-link-updated":
      return {
        ...projection,
        thread: applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "thread.guest-share-updated":
      return {
        ...base,
        thread: event.payload,
      };
    // Reordering and PR refreshes preserve the orchestrator's activity timestamp.
    case "thread.active-reordered":
    case "thread.pull-request-synced":
      return {
        ...base,
        thread: event.payload,
        updatedAt: event.payload.updatedAt,
      };
    case "thread.visited":
    case "thread.marked-unread":
      return {
        ...projection,
        thread: event.payload,
      };
    case "run.created":
    case "run.updated":
      return withLocalVisibleTurnItems({
        ...base,
        runs: upsertById(
          base.runs,
          preserveRunRecordedFields(
            base.runs.find((run) => run.id === event.payload.id),
            event.payload,
          ),
        ),
      });
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run-attempt.created":
    case "run-attempt.updated":
      return withLocalVisibleTurnItems({
        ...base,
        attempts: upsertById(base.attempts, event.payload),
      });
    case "node.updated":
      return {
        ...base,
        nodes: upsertById(base.nodes, event.payload),
      };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertById(
          base.subagents,
          preserveCompletionDelivery(
            base.subagents.find((task) => task.id === event.payload.id),
            event.payload,
          ),
        ),
      };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertById(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return {
        ...base,
        thread:
          event.payload.appThreadId === base.thread.id &&
          !isQueuedProviderThreadPlaceholder(event.payload)
            ? {
                ...base.thread,
                activeProviderThreadId: event.payload.id,
              }
            : base.thread,
        providerThreads: upsertById(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertProviderTurn(base.providerTurns, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertById(base.runtimeRequests, event.payload),
      };
    case "message.updated":
      return {
        ...base,
        messages: upsertById(base.messages, event.payload),
      };
    case "turn-item.updated":
      return withLocalVisibleTurnItems({
        ...base,
        turnItems: upsertById(base.turnItems, event.payload),
      });
    case "plan.updated":
      return {
        ...base,
        plans: upsertById(base.plans, event.payload),
      };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertById(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return {
        ...base,
        checkpoints: upsertById(base.checkpoints, event.payload),
      };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertById(base.contextHandoffs, event.payload),
      };
    case "context-transfer.created":
    case "context-transfer.updated":
      return {
        ...base,
        contextTransfers: upsertById(base.contextTransfers, event.payload),
      };
  }
}

/** Sessions are shared across app threads, so session events update every binding. Provider-thread ownership is also global: latest wins. */
export interface ProjectionReplayState {
  readonly projections: Map<ThreadId, OrchestrationV2ThreadProjection>;
  readonly providerSessionThreadIds: Map<ProviderSessionId, ReadonlySet<ThreadId>>;
  readonly providerThreadInstanceIds: Map<ProviderThreadId, ProviderInstanceId>;
}

export function applyToProjectionReplayState(
  state: ProjectionReplayState,
  event: OrchestrationV2DomainEvent,
  options?: { readonly deferNotificationCursor?: boolean },
): boolean {
  if (event.type === "thread.created" && !state.projections.has(event.threadId)) {
    state.projections.set(event.threadId, emptyProjection(event));
    return true;
  }

  const current = state.projections.get(event.threadId);
  if (current === undefined) {
    return false;
  }

  let next = applyToProjection(current, event, options);
  if (event.type === "provider-session.updated") {
    const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id);
    if (boundThreadIds?.has(event.threadId) !== true) {
      next = { ...next, providerSessions: current.providerSessions };
    }
  }
  state.projections.set(event.threadId, next);

  switch (event.type) {
    case "provider-thread.updated": {
      state.providerThreadInstanceIds.set(event.payload.id, event.payload.providerInstanceId);
      // SQL's upsert moves the provider-thread row and its roster to appThreadId.
      for (const [threadId, projection] of state.projections) {
        if (threadId === event.payload.appThreadId) {
          if (threadId !== event.threadId) {
            state.projections.set(threadId, applyToProjection(projection, event));
          }
          continue;
        }
        const providerThreads = projection.providerThreads.filter(
          (thread) => thread.id !== event.payload.id,
        );
        if (providerThreads.length !== projection.providerThreads.length) {
          state.projections.set(threadId, { ...projection, providerThreads });
        }
      }
      break;
    }
    case "provider-session.attached": {
      const boundThreadIds = new Set(state.providerSessionThreadIds.get(event.payload.id) ?? []);
      boundThreadIds.add(event.threadId);
      state.providerSessionThreadIds.set(event.payload.id, boundThreadIds);
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.updated": {
      const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id) ?? [];
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.detached": {
      const boundThreadIds = new Set(
        state.providerSessionThreadIds.get(event.payload.providerSessionId) ?? [],
      );
      boundThreadIds.delete(event.threadId);
      if (boundThreadIds.size === 0) {
        state.providerSessionThreadIds.delete(event.payload.providerSessionId);
      } else {
        state.providerSessionThreadIds.set(event.payload.providerSessionId, boundThreadIds);
      }
      break;
    }
  }

  return true;
}
