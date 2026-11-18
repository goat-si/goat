import type { OrchestrationV2TurnItem, ThreadId } from "@goat/contracts";
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

  const writeReleasedBackgroundWorkEvents = (
    released: ReadonlyArray<ReleasedProviderThread>,
    releasedAt: DateTime.Utc,
  ) =>
    Effect.forEach(
      released,
      (providerThread) =>
        writeReleasedRosterEvents(providerThread).pipe(
          Effect.andThen(writeReleasedToolCallEvents(providerThread, releasedAt)),
        ),
      { discard: true },
    );

  return {
    readReleasedProviderThreads,
    writeReleasedToolCallEvents,
    writeReleasedBackgroundWorkEvents,
  };
};

export type ReleasedProviderThread = Parameters<
  ReturnType<typeof makeReleasedBackgroundWork>["writeReleasedToolCallEvents"]
>[0];
