import {
  isOrchestrationV2WorkActive,
  type CommandId,
  type EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@goat/contracts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
} from "@goat/provider-core/server/subagentProjection";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { OrchestratorDispatchError } from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

export interface DyingNativeSubagent {
  readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "subagents" | "turnItems">;
  readonly subagent: Pick<
    Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>,
    "subagentId" | "origin" | "childThreadId" | "providerInstanceId"
  >;
}

export const nativeSubagentRef = (
  subagent: OrchestrationV2Subagent,
): DyingNativeSubagent["subagent"] => ({
  subagentId: subagent.id,
  origin: subagent.origin,
  childThreadId: subagent.childThreadId,
  providerInstanceId: subagent.providerInstanceId,
});

/**
 * Native subagents of a thread's runs whose record still reads active with no live item.
 * Record and item are written together, so such a record lost its end.
 */
export const staleNativeSubagents = (
  projection: Pick<OrchestrationV2ThreadProjection, "subagents" | "turnItems">,
) =>
  projection.subagents.filter(
    (subagent) =>
      subagent.origin === "provider_native" &&
      subagent.runId !== null &&
      isOrchestrationV2WorkActive(subagent.status) &&
      !projection.turnItems.some(
        (item) => item.type === "subagent" && item.subagentId === subagent.id,
      ),
  );

export interface NativeSubagentTreeDeps<AllocateError> {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly allocateEvent: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
  }) => Effect.Effect<EventId, AllocateError>;
  readonly mapDispatchError: (
    command: OrchestrationV2ServerCommand,
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;
}

export const makeEndNativeSubagentTrees = <AllocateError>(
  deps: NativeSubagentTreeDeps<AllocateError>,
) =>
  // Ends each native subagent's record, its own thread's runless root turns, and the
  // subagents it started there, which a provider can record on that thread rather than its parent's.
  Effect.fn("Orchestrator.endNativeSubagentTrees")(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.background-work.settle" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly dying: ReadonlyArray<DyingNativeSubagent>;
    readonly childThreadIds: Set<ThreadId>;
    readonly now: DateTime.Utc;
  }) {
    const { projectionStore, mapDispatchError } = deps;
    const allocateEventId = () =>
      deps.allocateEvent({ threadId: input.command.threadId, commandId: input.command.commandId });
    const dying = [...input.dying];
    const { childThreadIds } = input;
    for (const { projection, subagent } of dying) {
      const ended = yield* endOrphanedNativeSubagent({
        projection,
        subagentId: subagent.subagentId,
        status: "interrupted",
        now: input.now,
        emitted: yield* Ref.get(input.events),
        allocateEventId,
      }).pipe(mapDispatchError(input.command));
      yield* Ref.update(input.events, (events) => [...events, ...ended]);
      const childThreadId = subagent.childThreadId;
      if (
        subagent.origin !== "provider_native" ||
        childThreadId === null ||
        childThreadIds.has(childThreadId)
      ) {
        continue;
      }
      childThreadIds.add(childThreadId);
      const child = yield* projectionStore
        .getThreadRecords(childThreadId, ["nodes", "providerTurns", "subagents", "turnItems"], {
          // Runless items are the subagent's; any run there is the user's own.
          turnItemRunIds: [null],
          turnItemStatuses: ["pending", "running", "waiting"],
        })
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          mapDispatchError(input.command),
        );
      if (child === null) continue;
      const childEnded = yield* endRunlessRootTurns({
        threadId: childThreadId,
        providerInstanceId: subagent.providerInstanceId,
        projection: child,
        status: "interrupted",
        now: input.now,
        emitted: yield* Ref.get(input.events),
        allocateEventId,
      }).pipe(mapDispatchError(input.command));
      yield* Ref.update(input.events, (events) => [...events, ...childEnded]);
      for (const nested of child.turnItems) {
        if (nested.type === "subagent") dying.push({ projection: child, subagent: nested });
      }
      for (const nested of child.subagents) {
        if (nested.origin === "provider_native" && nested.runId === null) {
          dying.push({ projection: child, subagent: nativeSubagentRef(nested) });
        }
      }
    }
  });
