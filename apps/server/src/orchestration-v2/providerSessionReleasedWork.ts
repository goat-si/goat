import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@goat/contracts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@goat/provider-core/server/subagentProjection";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EventSink from "./EventSink.ts";
import type * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderSessionReleaseReason } from "./ProviderSessionManager.ts";
import { releasedThreadIds } from "./providerSessionReleasedThreads.ts";

// Tool calls that only a live provider process can end.
const releasedToolCallTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]> = [
  "command_execution",
  "dynamic_tool",
];
const activeTurnItemStatuses: ReadonlyArray<OrchestrationV2TurnItem["status"]> = [
  "pending",
  "running",
  "waiting",
];

interface ReleasedSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly runtime: Pick<
    ProviderAdapter.ProviderAdapterV2SessionRuntime,
    "providerSessionId" | "backgroundTasksEndWithProcess"
  >;
}

export const makeReleasedBackgroundWork = ({
  projectionStore,
  eventSink,
  idAllocator,
}: {
  readonly projectionStore: ProjectionStore.ProjectionStoreV2["Service"];
  readonly eventSink: EventSink.EventSinkV2Shape;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
}) => {
  // Read the session's provider threads as soon as it leaves the live map, before a
  // replacement reports its own tasks. Keep OpenCode's background work: its background
  // subagents share a server and can outlive the session.
  const readReleasedProviderThreads = Effect.fn(
    "ProviderSessionManager.readReleasedProviderThreads",
  )(
    function* (input: {
      readonly entry: ReleasedSessionEntry;
      readonly reason: ProviderSessionReleaseReason;
      readonly detachedThreadId?: ThreadId;
    }) {
      if (
        input.reason === "server_shutdown" ||
        input.entry.runtime.backgroundTasksEndWithProcess !== true
      ) {
        return [];
      }
      const providerSessionId = input.entry.runtime.providerSessionId;
      const released = [];
      for (const threadId of releasedThreadIds(input)) {
        const projection = yield* projectionStore.getThreadRecords(threadId, ["providerThreads"]);
        for (const providerThread of projection.providerThreads) {
          if (providerThread.providerSessionId !== providerSessionId) continue;
          released.push({
            threadId,
            providerSessionId,
            providerThreadId: providerThread.id,
            driver: providerThread.driver,
            taskIds: new Set(
              (providerThread.pendingBackgroundTasks ?? []).map((task) => task.taskId),
            ),
          });
        }
      }
      return released;
    },
    (effect, input) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.provider-session-release-roster-read-failed", {
            providerSessionId: input.entry.runtime.providerSessionId,
            cause,
          }).pipe(Effect.as([])),
        ),
      ),
  );
  type ReleasedProviderThread = Effect.Success<
    ReturnType<typeof readReleasedProviderThreads>
  >[number];

  // Dead processes cannot report task endings; stale rosters keep threads Waiting.
  const writeReleasedRosterEvents = Effect.fn("ProviderSessionManager.writeReleasedRosterEvents")(
    function* ({ threadId, providerSessionId, providerThreadId, taskIds }: ReleasedProviderThread) {
      if (taskIds.size === 0) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const projection = yield* projectionStore.getThreadRecords(threadId, ["providerThreads"]);
        const providerThread = projection.providerThreads.find(
          (candidate) => candidate.id === providerThreadId,
        );
        const tasks = providerThread?.pendingBackgroundTasks ?? [];
        const remaining = tasks.filter((task) => !taskIds.has(task.taskId));
        if (providerThread === undefined || remaining.length === tasks.length) return;
        const now = yield* DateTime.now;
        const { committed } = yield* eventSink.writeIfProviderThreadUnchanged({
          expected: providerThread,
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
              type: "provider-thread.updated",
              threadId,
              driver: providerThread.driver,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...providerThread,
                pendingBackgroundTasks: remaining,
                updatedAt: now,
              },
            },
          ],
        });
        if (committed) return;
      }
      yield* Effect.logWarning("orchestration-v2.provider-session-release-roster-conflict", {
        providerSessionId,
        providerThreadId,
      });
    },
  );

  // Tool calls the dead process started never report an end either, and run finalization
  // keeps them open for a late result. Items started after the release belong to a
  // replacement session. Subagent rows are left out: run finalization ends run-owned ones.
  const writeReleasedToolCallEvents = Effect.fn(
    "ProviderSessionManager.writeReleasedToolCallEvents",
  )(function* (released: ReleasedProviderThread, releasedAt: DateTime.Utc) {
    const { threadId, providerSessionId, providerThreadId, driver } = released;
    const readCutOff = projectionStore
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: releasedToolCallTypes,
        turnItemStatuses: activeTurnItemStatuses,
      })
      .pipe(
        Effect.map((projection) =>
          projection.turnItems.filter(
            (item) =>
              item.providerThreadId === providerThreadId &&
              DateTime.isLessThanOrEqualTo(item.startedAt ?? item.updatedAt, releasedAt),
          ),
        ),
      );
    // One write per item: a late completion from the dead session's queued events rejects
    // only the interrupt of its own item, and that item then is no longer open. Read again
    // after each pass: queued events can also store more cut-off items.
    let pending = yield* readCutOff;
    for (let pass = 0; pass < 3 && pending.length > 0; pass++) {
      for (const item of pending) {
        const now = yield* DateTime.now;
        yield* eventSink.writeIfTurnItemUnchanged({
          expected: item,
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
              type: "turn-item.updated",
              threadId,
              ...(item.runId === null ? {} : { runId: item.runId }),
              ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
              driver,
              occurredAt: now,
              payload: { ...item, status: "interrupted", completedAt: now, updatedAt: now },
            },
          ],
        });
      }
      pending = yield* readCutOff;
    }
    if (pending.length === 0) return;
    yield* Effect.logWarning("orchestration-v2.provider-session-release-tool-call-conflict", {
      providerSessionId,
      providerThreadId,
      openToolCalls: pending.length,
    });
  });

  const writeReleasedSubagentEvents = Effect.fn(
    "ProviderSessionManager.writeReleasedSubagentEvents",
  )(function* (
    { threadId, providerSessionId, providerThreadId, driver, taskIds }: ReleasedProviderThread,
    releasedAt: DateTime.Utc,
  ) {
    const readCutOff = Effect.gen(function* () {
      const projection = yield* projectionStore.getThreadRecords(
        threadId,
        ["subagents", "turnItems", "providerThreads"],
        { omitSettledSubagents: true, turnItemTypes: ["subagent"] },
      );
      const owner = projection.providerThreads.find(
        (thread) =>
          thread.id === providerThreadId && thread.providerSessionId === providerSessionId,
      );
      if (owner === undefined) return { ...projection, subagents: [] };
      const itemsBySubagent = new Map(
        projection.turnItems.flatMap((item) =>
          item.type === "subagent" ? [[item.subagentId, item] as const] : [],
        ),
      );
      const subagents = projection.subagents.filter((subagent) => {
        if (
          subagent.origin !== "provider_native" ||
          subagent.driver !== driver ||
          subagent.providerInstanceId !== owner.providerInstanceId ||
          !isOrchestrationV2WorkActive(subagent.status) ||
          DateTime.isGreaterThan(subagent.updatedAt, releasedAt)
        )
          return false;
        const item = itemsBySubagent.get(subagent.id);
        if (item?.providerThreadId != null) {
          return (
            item.providerThreadId === providerThreadId &&
            DateTime.isLessThanOrEqualTo(item.updatedAt, releasedAt)
          );
        }
        // Older rows can predate provider-thread attribution on the task card.
        const nativeTaskId = subagent.nativeTaskRef?.nativeId;
        return (
          (nativeTaskId != null && taskIds.has(nativeTaskId)) ||
          projection.providerThreads.filter(
            (thread) => thread.providerInstanceId === owner.providerInstanceId,
          ).length === 1
        );
      });
      return { ...projection, subagents };
    });

    let pending = yield* readCutOff;
    for (let pass = 0; pass < 3 && pending.subagents.length > 0; pass++) {
      const { nodes } = yield* projectionStore.getThreadRecords(threadId, ["nodes"], {
        nodeIds: pending.subagents.map(({ id }) => id),
      });
      for (const subagent of pending.subagents) {
        const now = yield* DateTime.now;
        const allocateEventId = () => idAllocator.allocate.event({ threadId, providerSessionId });
        const projection = { ...pending, nodes };
        const events = yield* endOrphanedNativeSubagent({
          projection,
          subagentId: subagent.id,
          status: "interrupted",
          now,
          emitted: [],
          allocateEventId,
        });
        const child =
          subagent.childThreadId === null
            ? null
            : yield* projectionStore
                .getThreadRecords(subagent.childThreadId, ["nodes", "providerTurns", "turnItems"], {
                  turnItemRunIds: [null],
                  turnItemStatuses: activeTurnItemStatuses,
                })
                .pipe(
                  Effect.catchTags({
                    ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                  }),
                );
        if (child !== null && subagent.childThreadId !== null) {
          events.push(
            ...(yield* endRunlessRootTurns({
              threadId: subagent.childThreadId,
              providerInstanceId: subagent.providerInstanceId,
              projection: {
                ...child,
                nodes: child.nodes.filter(
                  (node) =>
                    node.nativeItemRef?.nativeId != null &&
                    node.nativeItemRef.nativeId === subagent.nativeTaskRef?.nativeId &&
                    (node.startedAt === null ||
                      DateTime.isLessThanOrEqualTo(node.startedAt, releasedAt)),
                ),
              },
              status: "interrupted",
              now,
              emitted: events,
              allocateEventId,
            })),
          );
        }
        const nodeIds = new Set(
          events.flatMap((event) => (event.type === "node.updated" ? [event.payload.id] : [])),
        );
        const turnIds = new Set(
          events.flatMap((event) =>
            event.type === "provider-turn.updated" ? [event.payload.id] : [],
          ),
        );
        const itemIds = new Set(
          events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload.id] : [])),
        );
        yield* eventSink.writeIfReleasedSubagentUnchanged({
          expected: subagent,
          providerThreadId,
          providerSessionId,
          events,
          nodes: [...nodes, ...(child?.nodes ?? [])].filter(({ id }) => nodeIds.has(id)),
          turns: (child?.providerTurns ?? []).filter(({ id }) => turnIds.has(id)),
          items: [...pending.turnItems, ...(child?.turnItems ?? [])].filter(({ id }) =>
            itemIds.has(id),
          ),
        });
      }
      pending = yield* readCutOff;
    }
    if (pending.subagents.length > 0)
      yield* Effect.logWarning("orchestration-v2.provider-session-release-subagent-conflict", {
        providerSessionId,
        providerThreadId,
        openSubagents: pending.subagents.length,
      });
  });

  const writeReleasedProcessTaskEvents = (
    released: ReleasedProviderThread,
    releasedAt: DateTime.Utc,
  ) =>
    writeReleasedToolCallEvents(released, releasedAt).pipe(
      Effect.andThen(writeReleasedSubagentEvents(released, releasedAt)),
    );

  const writeReleasedBackgroundWorkEvents = (
    released: ReadonlyArray<ReleasedProviderThread>,
    releasedAt: DateTime.Utc,
  ) =>
    Effect.forEach(
      released,
      (providerThread) =>
        writeReleasedRosterEvents(providerThread).pipe(
          Effect.andThen(writeReleasedProcessTaskEvents(providerThread, releasedAt)),
        ),
      { discard: true },
    );

  return {
    readReleasedProviderThreads,
    writeReleasedProcessTaskEvents,
    writeReleasedBackgroundWorkEvents,
  };
};

export type ReleasedProviderThread = Parameters<
  ReturnType<typeof makeReleasedBackgroundWork>["writeReleasedProcessTaskEvents"]
>[0];
