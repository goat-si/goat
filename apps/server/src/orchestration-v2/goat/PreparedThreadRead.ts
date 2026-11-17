import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2 } from "../ProjectionStore.ts";

/** The thread a session prepare grants on, or None when it is missing or unreadable. */
export const readPreparedThread = (
  projectionStore: Pick<ProjectionStoreV2["Service"], "getThread">,
  threadId: ThreadId,
) => projectionStore.getThread(threadId).pipe(Effect.option);
