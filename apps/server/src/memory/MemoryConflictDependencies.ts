import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import {
  closureCap,
  requireClosureCapacity,
  validateSummaryDependencies,
} from "./MemoryDependencies.ts";
import type { MemoryStore } from "./MemoryStore.ts";

export const checkConflictDependencies = Effect.fn("MemorySyncService.checkConflictDependencies")(
  function* (
    store: MemoryStore["Service"],
    ticket: M.MemoryResolutionLease,
    inherited: readonly M.MemoryRevisionId[],
    dependencies: readonly M.MemoryRevisionId[],
  ) {
    const space = ticket.memorySpaceId;
    if (!(yield* store.areAutomaticallyUsable(space, ticket.conflictHeadSet)))
      return yield* new M.MemoryHubError({ code: "source_invalidated" });
    yield* requireClosureCapacity(dependencies.length, yield* closureCap(space));
    yield* validateSummaryDependencies(
      space,
      {
        text: "lineage admission",
        evidence: [],
        derivedFromMemoryRevisions: inherited.filter((id) => !ticket.conflictHeadSet.includes(id)),
      },
      { memoryId: ticket.memoryId, revisions: dependencies },
    );
  },
);
