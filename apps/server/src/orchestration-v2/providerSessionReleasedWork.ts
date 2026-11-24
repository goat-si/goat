import {
  isOrchestrationV2WorkActive,
  type NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2DomainEvent,
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
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderSessionReleaseReason } from "./ProviderSessionManager.ts";
import { releasedThreadIds } from "./providerSessionReleasedThreads.ts";
import { makeReleasedWorkNote } from "./providerSessionLostWork.ts";

// Tool calls that only a live provider process can end.
const releasedToolCallTypes: ReadonlyArray<OrchestrationV2TurnItem["type"]> = [
  "command_execution",
  "dynamic_tool",
];
const WORKFLOW_RELEASE_MEMBER_LIMIT = 128;
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
        const openItems =
          input.reason === "runtime_error"
            ? (yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
                turnItemTypes: [...releasedToolCallTypes, "subagent"],
                turnItemStatuses: activeTurnItemStatuses,
              })).turnItems
            : [];
        for (const providerThread of projection.providerThreads) {
          if (providerThread.providerSessionId !== providerSessionId) continue;
          released.push({
            threadId,
            providerSessionId,
            providerThreadId: providerThread.id,
            driver: providerThread.driver,
            interruptedWorkflows: new Map<
              NodeId,
              { readonly task: string; readonly card?: string }
            >(),
            lostTasks:
              input.reason === "runtime_error" && providerThread.ownerNodeId === null
                ? (providerThread.pendingBackgroundTasks ?? [])
                : [],
            lostItems:
              input.reason === "runtime_error" && providerThread.ownerNodeId === null
                ? openItems.filter(
                    (item) =>
                      item.providerThreadId === providerThread.id &&
                      (item.type !== "subagent" || item.origin === "provider_native"),
                  )
                : [],
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
      const { nodes } = yield* projectionStore.getThreadRecords(threadId, ["nodes"], {
        nodeIds: pending.flatMap((item) => (item.nodeId === null ? [] : [item.nodeId])),
      });
      for (const item of pending) {
        const now = yield* DateTime.now;
        const node = nodes.find((candidate) => candidate.id === item.nodeId);
        const events: Array<OrchestrationV2DomainEvent> = [];
        if (node !== undefined && isOrchestrationV2WorkActive(node.status)) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
            type: "node.updated",
            threadId,
            ...(node.runId === null ? {} : { runId: node.runId }),
            nodeId: node.id,
            driver,
            occurredAt: now,
            payload: { ...node, status: "interrupted", completedAt: now },
          });
        }
        events.push({
          id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
          type: "turn-item.updated",
          threadId,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          driver,
          occurredAt: now,
          payload: { ...item, status: "interrupted", completedAt: now, updatedAt: now },
        });
        yield* eventSink.writeIfTurnItemUnchanged({ expected: item, events });
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
    {
      threadId,
      providerSessionId,
      providerThreadId,
      driver,
      taskIds,
      interruptedWorkflows,
    }: ReleasedProviderThread,
    releasedAt: DateTime.Utc,
  ) {
    const readCutOff = Effect.gen(function* () {
      const projection = yield* projectionStore.getThreadRecords(
        threadId,
        ["subagents", "turnItems", "providerThreads"],
        {
          omitSettledSubagents: { except: [...interruptedWorkflows.keys()] },
          turnItemTypes: ["subagent"],
        },
      );
      const owner = projection.providerThreads.find(
        (thread) =>
          thread.id === providerThreadId && thread.providerSessionId === providerSessionId,
      );
      const itemsBySubagent = new Map(
        projection.turnItems.flatMap((item) =>
          item.type === "subagent" ? [[item.subagentId, item] as const] : [],
        ),
      );
      if (owner === undefined) return { ...projection, subagents: [], itemsBySubagent };
      const soleProviderThread =
        projection.providerThreads.filter(
          (thread) => thread.providerInstanceId === owner.providerInstanceId,
        ).length === 1;
      const subagents = yield* Effect.filter(projection.subagents, (subagent) =>
        Effect.gen(function* () {
          if (
            subagent.origin !== "provider_native" ||
            subagent.driver !== driver ||
            subagent.providerInstanceId !== owner.providerInstanceId
          )
            return false;
          const item = itemsBySubagent.get(subagent.id);
          // Older rows can predate provider-thread attribution on the task card.
          const nativeTaskId = subagent.nativeTaskRef?.nativeId;
          const ownsCard =
            item?.providerThreadId != null
              ? item.providerThreadId === providerThreadId
              : (nativeTaskId != null && taskIds.has(nativeTaskId)) || soleProviderThread;
          if (!ownsCard) return false;

          const interrupted = interruptedWorkflows.get(subagent.id);
          if (subagent.status === "interrupted" && interrupted !== undefined) {
            if (interrupted.task !== (yield* ProjectionStore.encodeSubagentPayload(subagent)))
              return false;
            const card =
              item === undefined ? undefined : yield* ProjectionStore.encodeTurnItemPayload(item);
            return interrupted.card === card;
          }
          return (
            isOrchestrationV2WorkActive(subagent.status) &&
            DateTime.isLessThanOrEqualTo(subagent.updatedAt, releasedAt) &&
            (item?.providerThreadId == null ||
              DateTime.isLessThanOrEqualTo(item.updatedAt, releasedAt))
          );
        }),
      );
      return { ...projection, subagents, itemsBySubagent };
    });

    const readChild = Effect.fn("ProviderSessionManager.readReleasedNativeChild")(function* (
      childThreadId: ThreadId,
      memberIds: ReadonlyArray<NodeId>,
    ) {
      return yield* projectionStore
        .getThreadRecords(childThreadId, ["nodes", "providerTurns", "turnItems", "subagents"], {
          turnItemRunIds: [null],
          turnItemStatuses: activeTurnItemStatuses,
          subagentIds: memberIds,
        })
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
    });
    type ChildWork = NonNullable<Effect.Success<ReturnType<typeof readChild>>>;
    const releaseRoot = (snapshot: ChildWork, task: OrchestrationV2Subagent) => {
      const root = snapshot.nodes.find(
        (node) =>
          node.kind === "root_turn" &&
          node.runId === null &&
          node.nativeItemRef?.nativeId != null &&
          node.nativeItemRef.nativeId === task.nativeTaskRef?.nativeId &&
          (node.startedAt === null || DateTime.isLessThanOrEqualTo(node.startedAt, releasedAt)),
      );
      return {
        root,
        projection: {
          nodes: root === undefined ? [] : [root],
          providerTurns: snapshot.providerTurns.filter(
            (turn) =>
              turn.startedAt === null || DateTime.isLessThanOrEqualTo(turn.startedAt, releasedAt),
          ),
          turnItems: snapshot.turnItems.filter((item) =>
            DateTime.isLessThanOrEqualTo(item.updatedAt, releasedAt),
          ),
        },
      };
    };

    let pending = yield* readCutOff;
    for (let pass = 0; pass < 3 && pending.subagents.length > 0; pass++) {
      const { nodes } = yield* projectionStore.getThreadRecords(threadId, ["nodes"], {
        nodeIds: pending.subagents.map(({ id }) => id),
      });
      let attempted = false;
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
        const members: OrchestrationV2Subagent[] = [];
        const snapshots: ChildWork[] = [];
        const coordinatorThread = subagent.childThreadId;
        if (coordinatorThread !== null) {
          const references = (subagent.workflow?.agents ?? [])
            .slice(0, WORKFLOW_RELEASE_MEMBER_LIMIT)
            .flatMap((member) => {
              if (member.childThreadId === undefined) return [];
              const nativeId = `${coordinatorThread}:agent:${member.index}`;
              return [
                {
                  id: idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId: nativeId }),
                  nativeId,
                  threadId: member.childThreadId,
                },
              ];
            });
          const child = yield* readChild(
            coordinatorThread,
            references.map(({ id }) => id),
          );
          if (child !== null) {
            snapshots.push(child);
            const owned = releaseRoot(child, subagent);
            const endChild = (
              task: OrchestrationV2Subagent,
              childThreadId: ThreadId,
              root: ReturnType<typeof releaseRoot>,
            ) =>
              endRunlessRootTurns({
                threadId: childThreadId,
                providerInstanceId: task.providerInstanceId,
                projection: root.projection,
                status: "interrupted",
                now,
                emitted: events,
                allocateEventId,
              });
            events.push(...(yield* endChild(subagent, coordinatorThread, owned)));
            for (const reference of references) {
              const member = child.subagents.find(({ id }) => id === reference.id);
              if (
                member === undefined ||
                owned.root === undefined ||
                member.parentNodeId !== owned.root.id ||
                member.childThreadId !== reference.threadId ||
                member.nativeTaskRef?.nativeId !== reference.nativeId ||
                member.driver !== driver ||
                member.providerInstanceId !== subagent.providerInstanceId ||
                member.origin !== "provider_native" ||
                member.runId !== null ||
                member.providerThreadId !== null ||
                !isOrchestrationV2WorkActive(member.status) ||
                DateTime.isGreaterThan(member.updatedAt, releasedAt)
              )
                continue;
              members.push(member);
              events.push(
                ...(yield* endOrphanedNativeSubagent({
                  projection: { ...owned.projection, nodes: child.nodes, subagents: [member] },
                  subagentId: member.id,
                  status: "interrupted",
                  now,
                  emitted: events,
                  allocateEventId,
                })),
              );
              const memberChild = yield* readChild(reference.threadId, []);
              if (memberChild !== null) {
                snapshots.push(memberChild);
                events.push(
                  ...(yield* endChild(
                    member,
                    reference.threadId,
                    releaseRoot(memberChild, member),
                  )),
                );
              }
            }
          }
        }
        if (events.length === 0) continue;
        attempted = true;
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
        const card = pending.itemsBySubagent.get(subagent.id);
        if (card !== undefined) itemIds.add(card.id);
        const { committed, storedEvents } = yield* eventSink.writeIfReleasedSubagentUnchanged({
          expected: subagent,
          members,
          providerThreadId,
          providerSessionId,
          events,
          nodes: [...nodes, ...snapshots.flatMap(({ nodes }) => nodes)].filter(({ id }) =>
            nodeIds.has(id),
          ),
          turns: snapshots
            .flatMap(({ providerTurns }) => providerTurns)
            .filter(({ id }) => turnIds.has(id)),
          items: [...pending.turnItems, ...snapshots.flatMap(({ turnItems }) => turnItems)].filter(
            ({ id }) => itemIds.has(id),
          ),
        });
        if (
          committed &&
          subagent.workflow !== undefined &&
          isOrchestrationV2WorkActive(subagent.status) &&
          interruptedWorkflows.size < WORKFLOW_RELEASE_MEMBER_LIMIT
        ) {
          const writtenTask = storedEvents
            .map(({ event }) => event)
            .find((event) => event.type === "subagent.updated" && event.payload.id === subagent.id);
          const writtenCard = storedEvents
            .map(({ event }) => event)
            .find((event) => event.type === "turn-item.updated" && event.payload.id === card?.id);
          if (writtenTask?.type === "subagent.updated") {
            const currentCard =
              writtenCard?.type === "turn-item.updated" ? writtenCard.payload : card;
            interruptedWorkflows.set(subagent.id, {
              task: yield* ProjectionStore.encodeSubagentPayload(writtenTask.payload),
              ...(currentCard === undefined
                ? {}
                : { card: yield* ProjectionStore.encodeTurnItemPayload(currentCard) }),
            });
          }
        }
      }
      if (!attempted) return;
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

  const writeReleasedWorkNote = makeReleasedWorkNote({ projectionStore, eventSink, idAllocator });

  const writeReleasedBackgroundWorkEvents = (
    released: ReadonlyArray<ReleasedProviderThread>,
    releasedAt: DateTime.Utc,
  ) =>
    Effect.forEach(
      released,
      (providerThread) =>
        writeReleasedRosterEvents(providerThread).pipe(
          Effect.andThen(writeReleasedProcessTaskEvents(providerThread, releasedAt)),
          Effect.andThen(writeReleasedWorkNote(providerThread)),
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
