import type * as M from "@goat/contracts";
import * as Stream from "effect/Stream";

export const terminalRunStatuses = new Set(["completed", "failed", "interrupted", "cancelled"]);

/** Catch-up acts only on deletions and run ends; text deltas would otherwise sweep back to back. */
export const catchUpWakes = <E>(events: Stream.Stream<M.OrchestrationV2StoredEvent, E>) =>
  Stream.filter(
    events,
    ({ event }) =>
      event.type === "thread.deleted" ||
      (event.type === "run.updated" &&
        (terminalRunStatuses.has(event.payload.status) || event.payload.status === "rolled_back")),
  );
