import {
  isOrchestrationV2WorkActive,
  type EventId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type { EventSinkV2Shape } from "./EventSinkShape.ts";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";
import {
  cascadeTerminalizeRunOwnedSubagents,
  emptyOpenRunOwnedSubagentProjection,
  isOpenExecutionNodeStatus,
  type OpenRunOwnedSubagentProjection,
} from "./RunOwnedSubagentProjection.ts";
import { isSettledTurnItemStatus } from "./providerTurnStatus.ts";
import type { OrchestrationV2Run } from "@goat/contracts";

const MAX_SETTLEMENT_ATTEMPTS = 3;
const isProcessBoundToolCall = (item: OrchestrationV2TurnItem) =>
  item.type === "command_execution" || item.type === "dynamic_tool";

export type UnsettledWork = {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly nodes: ReadonlyArray<OrchestrationV2ExecutionNode>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
};
const isSettledSubagentStatus = (status: OrchestrationV2Subagent["status"]) =>
  !isOrchestrationV2WorkActive(status);

export const interruptLostToolCalls = Effect.fn("RunExecutionService.interruptLostToolCalls")(
  function* (input: {
    readonly run: OrchestrationV2Run;
    readonly toolCalls: Iterable<OrchestrationV2TurnItem>;
    readonly completedAt: DateTime.Utc;
    readonly allocateEventId: () => Effect.Effect<
      EventId,
      IdAllocator.IdAllocatorV2AllocationError
    >;
  }) {
    const events: Array<OrchestrationV2DomainEvent> = [];
    for (const toolCall of input.toolCalls) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: toolCall.threadId,
        runId: toolCall.runId ?? input.run.id,
        ...(toolCall.nodeId === null ? {} : { nodeId: toolCall.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...toolCall,
          status: "interrupted",
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    return events;
  },
);

export function makeLostProviderWork(
  input: Pick<RunExecutionServiceV2StartRootRunInput, "run" | "loadUnsettledWork">,
  openRunOwnedSubagents: Ref.Ref<OpenRunOwnedSubagentProjection>,
  openRootToolCalls: Ref.Ref<ReadonlySet<TurnItemId>>,
  eventSink: EventSinkV2Shape,
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
) {
  const loadTrackedWork = Effect.fn("RunExecutionService.loadTrackedWork")(function* (
    threadIds: Iterable<ThreadId>,
  ) {
    const open = yield* Ref.get(openRunOwnedSubagents);
    const subagents = new Map<NodeId, OrchestrationV2Subagent>();
    const nodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
    const turnItems = new Map<TurnItemId, OrchestrationV2TurnItem>();
    if (input.loadUnsettledWork === undefined) return { subagents, nodes, turnItems };
    const trackedRoot = yield* Ref.get(openRootToolCalls);
    const trackedItemIds = new Set<TurnItemId>([
      ...trackedRoot.keys(),
      ...open.childTurnItems.keys(),
      ...[...open.turnItems.values()].map((item) => item.id),
    ]);
    for (const threadId of new Set(threadIds)) {
      const stored = yield* input.loadUnsettledWork(
        threadId,
        [...open.nodes.values(), ...open.subagents.values()]
          .filter((record) => record.threadId === threadId)
          .map((record) => record.id),
      );
      for (const subagent of stored.subagents) {
        if (open.subagents.has(subagent.id) && !isSettledSubagentStatus(subagent.status)) {
          subagents.set(subagent.id, subagent);
        }
      }
      for (const node of stored.nodes) {
        if (open.nodes.has(node.id) && isOpenExecutionNodeStatus(node.status)) {
          nodes.set(node.id, node);
        }
      }
      for (const item of stored.turnItems) {
        if (trackedItemIds.has(item.id) && !isSettledTurnItemStatus(item.status)) {
          turnItems.set(item.id, item);
        }
      }
    }
    return { subagents, nodes, turnItems };
  });
  const loadLostRootToolCalls = loadTrackedWork([input.run.threadId]).pipe(
    Effect.flatMap(({ turnItems }) =>
      Ref.get(openRootToolCalls).pipe(
        Effect.map((trackedRoot) =>
          [...turnItems.values()].filter(
            (item) =>
              item.threadId === input.run.threadId &&
              trackedRoot.has(item.id) &&
              isProcessBoundToolCall(item),
          ),
        ),
      ),
    ),
  );
  // Subagents and tool calls that outlived the root run die with the provider runtime. Stop
  // can settle them meanwhile, so each write holds only while its stored row is unchanged.
  const endWorkLostAfterRootRun = Effect.fn("RunExecutionService.endWorkLostAfterRootRun")(
    function* (completedAt: DateTime.Utc) {
      const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
      const open = yield* Ref.get(openRunOwnedSubagents);
      const threadIds = [
        input.run.threadId,
        ...[
          ...open.subagents.values(),
          ...open.nodes.values(),
          ...open.childTurnItems.values(),
        ].map((record) => record.threadId),
      ];
      const stored = yield* loadTrackedWork(threadIds);
      for (const initial of stored.subagents.values()) {
        let latest = stored;
        for (let attempt = 0; attempt < MAX_SETTLEMENT_ATTEMPTS; attempt++) {
          const subagent = latest.subagents.get(initial.id);
          if (subagent === undefined) break;
          const subagentItemId = open.turnItems.get(subagent.id)?.id;
          const subagentItem =
            subagentItemId === undefined ? undefined : latest.turnItems.get(subagentItemId);
          const groupedItems = [...latest.turnItems].filter(
            ([id, item]) => open.childTurnItems.has(id) && item.threadId === subagent.childThreadId,
          );
          const groupedNodes = [...latest.nodes].filter(
            ([id, node]) => id === subagent.id || node.threadId === subagent.childThreadId,
          );
          const events = yield* cascadeTerminalizeRunOwnedSubagents({
            run: input.run,
            open: {
              subagents: new Map([[subagent.id, subagent]]),
              turnItems: new Map(
                subagentItem?.type === "subagent" ? [[subagent.id, subagentItem]] : [],
              ),
              childTurnItems: new Map(groupedItems),
              nodes: new Map(groupedNodes),
              linkedChildThreadIds: new Set(
                subagent.childThreadId === null ? [] : [subagent.childThreadId],
              ),
            },
            status: "failed",
            completedAt,
            allocateEventId,
          });
          const result = yield* eventSink.writeIfSubagentUnchanged({
            expected: subagent,
            nodes: groupedNodes.map(([, node]) => node),
            items: [
              ...(subagentItem === undefined ? [] : [subagentItem]),
              ...groupedItems.map(([, item]) => item),
            ],
            events,
          });
          if (result.committed) break;
          if (attempt + 1 === MAX_SETTLEMENT_ATTEMPTS) {
            yield* Effect.logWarning(
              "orchestration V2 could not settle provider work after concurrent changes",
              {
                threadId: input.run.threadId,
                runId: input.run.id,
              },
            );
          } else {
            latest = yield* loadTrackedWork(threadIds);
          }
        }
      }
      const trackedRoot = yield* Ref.get(openRootToolCalls);
      for (const toolCall of stored.turnItems.values()) {
        if (
          toolCall.threadId !== input.run.threadId ||
          !trackedRoot.has(toolCall.id) ||
          !isProcessBoundToolCall(toolCall)
        )
          continue;
        yield* eventSink.writeIfTurnItemUnchanged({
          expected: toolCall,
          events: yield* interruptLostToolCalls({
            run: input.run,
            toolCalls: [toolCall],
            completedAt,
            allocateEventId,
          }),
        });
      }
      yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
    },
    (effect) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning(
              "orchestration V2 failed to end work lost with the provider runtime",
              { runId: input.run.id, cause },
            ),
        ),
      ),
  );

  return { loadLostRootToolCalls, endWorkLostAfterRootRun };
}
