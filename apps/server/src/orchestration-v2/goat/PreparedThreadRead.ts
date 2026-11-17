import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2 } from "../ProjectionStore.ts";

/**
 * The thread a session prepare grants on, or None when it is missing or unreadable. A missing thread
 * is an ordinary unusable destination; a failed read is logged with its category only, as in
 * DurableRevocations, since its cause can carry private data.
 */
export const readPreparedThread = (
  projectionStore: Pick<ProjectionStoreV2["Service"], "getThread">,
  threadId: ThreadId,
) =>
  projectionStore.getThread(threadId).pipe(
    Effect.tapError((error) =>
      error._tag === "ProjectionStoreThreadNotFoundError"
        ? Effect.void
        : Effect.logWarning("Could not read a thread for its session prepare; it gets no grants.", {
            threadId,
            reason: error._tag,
          }),
    ),
    Effect.option,
  );
