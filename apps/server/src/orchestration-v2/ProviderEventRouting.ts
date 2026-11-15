import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { backgroundCapableTurnItemTypes } from "./InheritedBackgroundTurnItems.ts";
import { isSettledTurnItemStatus } from "./providerTurnStatus.ts";

export interface ProviderEventRoutingState {
  readonly ownedThreadIds: ReadonlySet<ThreadId>;
  // After root settlement, new children belong to the live run unless their coordinator still holds this run open.
  readonly rootTurnEnded: boolean;
  readonly workflowMemberParents: ReadonlyMap<ThreadId, ThreadId>;
  readonly ownedProviderThreadIds: ReadonlySet<ProviderThreadId>;
  readonly ownedProviderTurns: ReadonlyMap<ProviderTurnId, ProviderThreadId>;
  readonly inheritedBackgroundTurnItems: ReadonlyMap<TurnItemId, OrchestrationV2Run["id"]>;
  readonly rootProviderTurnId: ProviderTurnId | null;
}

export interface ProviderEventRouteIdentity {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly attemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
}

export interface InheritedBackgroundTurnItemRoute {
  readonly id: TurnItemId;
  readonly runId: OrchestrationV2Run["id"];
}

export function makeProviderEventRoutingState(input: {
  readonly identity: ProviderEventRouteIdentity;
  readonly inheritedBackgroundTurnItems?: ReadonlyArray<InheritedBackgroundTurnItemRoute>;
  readonly providerTurnId: ProviderTurnId | null;
  readonly relatedThreadIds?: ReadonlyArray<ThreadId>;
  readonly relatedProviderThreadIds?: ReadonlyArray<ProviderThreadId>;
}): ProviderEventRoutingState {
  return {
    ownedThreadIds: new Set([input.identity.threadId, ...(input.relatedThreadIds ?? [])]),
    rootTurnEnded: false,
    workflowMemberParents: new Map(),
    ownedProviderThreadIds: new Set([
      input.identity.providerThreadId,
      ...(input.relatedProviderThreadIds ?? []),
    ]),
    ownedProviderTurns:
      input.providerTurnId === null
        ? new Map()
        : new Map([[input.providerTurnId, input.identity.providerThreadId]]),
    inheritedBackgroundTurnItems: new Map(
      (input.inheritedBackgroundTurnItems ?? []).map((item) => [item.id, item.runId]),
    ),
    rootProviderTurnId: input.providerTurnId,
  };
}

export function routeProviderEvent(
  event: ProviderAdapter.ProviderAdapterV2Event,
  input: ProviderEventRouteIdentity,
  state: ProviderEventRoutingState,
): readonly [boolean, ProviderEventRoutingState] {
  const ownsThread = (threadId: ThreadId): boolean => state.ownedThreadIds.has(threadId);
  const ownsChildThread = (threadId: ThreadId): boolean =>
    threadId !== input.threadId && ownsThread(threadId);
  const ownsRun = (runId: string | null): boolean => runId === input.runId;
  const addProviderThread = (providerThreadId: ProviderThreadId): ProviderEventRoutingState => ({
    ...state,
    ownedProviderThreadIds: new Set([...state.ownedProviderThreadIds, providerThreadId]),
  });
  const addProviderTurn = (
    providerTurnId: ProviderTurnId,
    providerThreadId: ProviderThreadId,
    root: boolean,
  ): ProviderEventRoutingState => ({
    ...state,
    ownedProviderTurns: new Map(state.ownedProviderTurns).set(providerTurnId, providerThreadId),
    rootProviderTurnId: root ? providerTurnId : state.rootProviderTurnId,
  });

  switch (event.type) {
    case "provider_session.updated":
      return [false, state];
    case "app_thread.created": {
      if (event.appThread.id === input.threadId) {
        return [true, state];
      }
      const isOwnedSubagent =
        event.appThread.lineage.relationshipToParent === "subagent" &&
        event.appThread.lineage.parentThreadId !== null &&
        ownsThread(event.appThread.lineage.parentThreadId) &&
        (!state.rootTurnEnded ||
          state.workflowMemberParents.get(event.appThread.id) ===
            event.appThread.lineage.parentThreadId);
      if (!isOwnedSubagent) {
        return [false, state];
      }
      return [
        true,
        {
          ...state,
          ownedThreadIds: new Set([...state.ownedThreadIds, event.appThread.id]),
        },
      ];
    }
    case "provider_thread.updated": {
      const belongs =
        state.ownedProviderThreadIds.has(event.providerThread.id) ||
        (event.providerThread.appThreadId !== null && ownsThread(event.providerThread.appThreadId));
      return belongs ? [true, addProviderThread(event.providerThread.id)] : [false, state];
    }
    case "provider_turn.updated": {
      const isRoot = event.providerTurn.runAttemptId === input.attemptId;
      const belongs =
        isRoot ||
        (event.providerTurn.providerThreadId !== input.providerThreadId &&
          state.ownedProviderThreadIds.has(event.providerTurn.providerThreadId)) ||
        state.ownedProviderTurns.has(event.providerTurn.id) ||
        (event.threadId !== undefined && ownsChildThread(event.threadId));
      return belongs
        ? [
            true,
            addProviderTurn(event.providerTurn.id, event.providerTurn.providerThreadId, isRoot),
          ]
        : [false, state];
    }
    case "node.updated": {
      const belongs = ownsRun(event.node.runId) || ownsChildThread(event.node.threadId);
      if (!belongs || event.node.providerThreadId === null) {
        return [belongs, state];
      }
      return [true, addProviderThread(event.node.providerThreadId)];
    }
    case "subagent.updated": {
      const moved = event.subagent;
      if (
        moved.origin === "provider_native" &&
        moved.threadId === input.threadId &&
        moved.runId !== null &&
        !ownsRun(moved.runId) &&
        moved.childThreadId !== null &&
        ownsChildThread(moved.childThreadId)
      ) {
        const ownedThreadIds = new Set(state.ownedThreadIds);
        ownedThreadIds.delete(moved.childThreadId);
        const ownedProviderThreadIds = new Set(state.ownedProviderThreadIds);
        if (moved.providerThreadId !== null) ownedProviderThreadIds.delete(moved.providerThreadId);
        const ownedProviderTurns = new Map(state.ownedProviderTurns);
        for (const [turnId, threadId] of ownedProviderTurns) {
          if (threadId === moved.providerThreadId) ownedProviderTurns.delete(turnId);
        }
        return [false, { ...state, ownedThreadIds, ownedProviderThreadIds, ownedProviderTurns }];
      }
      const belongs = ownsRun(event.subagent.runId) || ownsChildThread(event.subagent.threadId);
      const coordinator = event.subagent;
      // Resumes reattribute child threads to the live run, which may not have observed their creation.
      const adopted =
        ownsRun(coordinator.runId) &&
        !state.rootTurnEnded &&
        isOrchestrationV2WorkActive(coordinator.status) &&
        coordinator.origin === "provider_native" &&
        coordinator.childThreadId !== null &&
        !ownsThread(coordinator.childThreadId)
          ? {
              ...state,
              ownedThreadIds: new Set([...state.ownedThreadIds, coordinator.childThreadId]),
            }
          : state;
      if (
        !ownsRun(coordinator.runId) ||
        coordinator.workflow === undefined ||
        coordinator.childThreadId === null
      ) {
        return [belongs, adopted];
      }
      const workflowMemberParents = new Map(state.workflowMemberParents);
      for (const member of coordinator.workflow.agents) {
        if (member.childThreadId !== undefined) {
          workflowMemberParents.set(member.childThreadId, coordinator.childThreadId);
        }
      }
      return [true, { ...adopted, workflowMemberParents }];
    }
    case "message.updated":
      return [ownsRun(event.message.runId) || ownsChildThread(event.message.threadId), state];
    case "steer.updated":
      return [ownsRun(event.runId), state];
    case "turn_item.updated": {
      if (ownsRun(event.turnItem.runId) || ownsChildThread(event.turnItem.threadId)) {
        return [true, state];
      }
      const inheritedRunId = state.inheritedBackgroundTurnItems.get(event.turnItem.id);
      const isInheritedBackgroundItem =
        event.turnItem.threadId === input.threadId &&
        event.turnItem.runId !== null &&
        event.turnItem.runId === inheritedRunId &&
        backgroundCapableTurnItemTypes.has(event.turnItem.type);
      if (!isInheritedBackgroundItem) {
        return [false, state];
      }
      if (!isSettledTurnItemStatus(event.turnItem.status)) {
        return [true, state];
      }
      const inheritedBackgroundTurnItems = new Map(state.inheritedBackgroundTurnItems);
      inheritedBackgroundTurnItems.delete(event.turnItem.id);
      return [true, { ...state, inheritedBackgroundTurnItems }];
    }
    case "plan.updated":
      return [ownsRun(event.plan.runId) || ownsChildThread(event.plan.threadId), state];
    case "runtime_request.updated":
      return [
        (event.threadId !== undefined && ownsChildThread(event.threadId)) ||
          (event.runtimeRequest.providerTurnId !== null &&
            state.ownedProviderTurns.has(event.runtimeRequest.providerTurnId)),
        state,
      ];
    case "background_work.updated":
      return [state.ownedProviderTurns.has(event.providerTurnId), state];
    case "command_output.delta":
      // The session manager hands live output to the command output hub; runs never see it.
      return [false, state];
    case "turn.terminal":
      return event.providerTurnId === state.rootProviderTurnId
        ? [true, { ...state, rootTurnEnded: true }]
        : [false, state];
  }
}
