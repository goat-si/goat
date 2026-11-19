import {
  isOrchestrationV2WorkActive,
  type EventId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { isSettledTurnItemStatus } from "./providerTurnStatus.ts";

type ProviderTerminalEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "turn.terminal" }
>;

function isSettledSubagentStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}

export type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

export type OpenRunOwnedSubagentProjection = {
  readonly subagents: ReadonlyMap<NodeId, OrchestrationV2Subagent>;
  readonly turnItems: ReadonlyMap<NodeId, SubagentTurnItem>;
  readonly childTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2TurnItem>;
  readonly nodes: ReadonlyMap<NodeId, OrchestrationV2ExecutionNode>;
  readonly linkedChildThreadIds: ReadonlySet<ThreadId>;
};

export type RunOwnedSubagentTerminalStatus = Extract<
  OrchestrationV2Subagent["status"],
  "interrupted" | "failed" | "cancelled"
>;

export function isOpenExecutionNodeStatus(status: OrchestrationV2ExecutionNode["status"]): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export function isRunOwnedSubagentTerminalStatus(
  status: ProviderTerminalEvent["status"],
): status is RunOwnedSubagentTerminalStatus {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

export function emptyOpenRunOwnedSubagentProjection(): OpenRunOwnedSubagentProjection {
  return {
    subagents: new Map(),
    turnItems: new Map(),
    childTurnItems: new Map(),
    nodes: new Map(),
    linkedChildThreadIds: new Set(),
  };
}

export function withLinkedChildThreadId(
  current: OpenRunOwnedSubagentProjection,
  childThreadId: ThreadId | null,
): OpenRunOwnedSubagentProjection {
  if (childThreadId === null || current.linkedChildThreadIds.has(childThreadId)) {
    return current;
  }
  const linkedChildThreadIds = new Set(current.linkedChildThreadIds);
  linkedChildThreadIds.add(childThreadId);
  return { ...current, linkedChildThreadIds };
}

export const cascadeTerminalizeRunOwnedSubagents = Effect.fn(
  "RunExecutionService.cascadeTerminalizeRunOwnedSubagents",
)(function* (input: {
  readonly run: OrchestrationV2Run;
  readonly open: OpenRunOwnedSubagentProjection;
  readonly status: RunOwnedSubagentTerminalStatus;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, IdAllocator.IdAllocatorV2AllocationError>;
}): Effect.fn.Return<
  ReadonlyArray<OrchestrationV2DomainEvent>,
  IdAllocator.IdAllocatorV2AllocationError
> {
  const events: Array<OrchestrationV2DomainEvent> = [];
  // Prefer lifetime linkage over currently-open rows: subagent/turn-item
  // snapshots may terminalize before the linked child-thread node settles.
  const childThreadIds = new Set(input.open.linkedChildThreadIds);
  for (const item of [...input.open.subagents.values(), ...input.open.turnItems.values()]) {
    if (item.childThreadId !== null) {
      childThreadIds.add(item.childThreadId);
    }
  }
  const keys = new Set<NodeId>([
    ...input.open.subagents.keys(),
    ...input.open.turnItems.keys(),
    ...input.open.nodes.keys(),
  ]);
  for (const key of keys) {
    const subagent = input.open.subagents.get(key);
    if (subagent !== undefined && !isSettledSubagentStatus(subagent.status)) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "subagent.updated",
        threadId: subagent.threadId,
        runId: input.run.id,
        nodeId: subagent.id,
        driver: subagent.driver,
        providerInstanceId: subagent.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...subagent,
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
    const node = input.open.nodes.get(key);
    if (
      node !== undefined &&
      ((node.threadId === input.run.threadId && node.runId === input.run.id) ||
        childThreadIds.has(node.threadId)) &&
      isOpenExecutionNodeStatus(node.status)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "node.updated",
        threadId: node.threadId,
        runId: node.runId ?? input.run.id,
        nodeId: node.id,
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...node,
          status: input.status,
          completedAt: input.completedAt,
        },
      });
    }
    const turnItem = input.open.turnItems.get(key);
    if (
      turnItem !== undefined &&
      turnItem.runId === input.run.id &&
      !isSettledTurnItemStatus(turnItem.status)
    ) {
      events.push({
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        threadId: turnItem.threadId,
        runId: input.run.id,
        ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.completedAt,
        payload: {
          ...turnItem,
          status: input.status,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      });
    }
  }
  for (const turnItem of input.open.childTurnItems.values()) {
    if (!childThreadIds.has(turnItem.threadId) || isSettledTurnItemStatus(turnItem.status)) {
      continue;
    }
    events.push({
      id: yield* input.allocateEventId(),
      type: "turn-item.updated",
      threadId: turnItem.threadId,
      runId: turnItem.runId ?? input.run.id,
      ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
      providerInstanceId: input.run.providerInstanceId,
      occurredAt: input.completedAt,
      payload: {
        ...turnItem,
        ...("streaming" in turnItem ? { streaming: false } : {}),
        status: input.status,
        completedAt: input.completedAt,
        updatedAt: input.completedAt,
      },
    });
  }
  return events;
});
