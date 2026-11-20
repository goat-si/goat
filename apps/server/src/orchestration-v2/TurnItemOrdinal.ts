import type { OrchestrationV2ThreadProjection, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";

export const makeNextTurnItemOrdinal =
  <E>(
    read: ProjectionStoreV2["Service"]["getNextTurnItemOrdinal"],
    mapError: (threadId: ThreadId, cause: unknown) => E,
  ) =>
  (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) =>
    read(projection.thread.id).pipe(
      Effect.mapError((cause) => mapError(projection.thread.id, cause)),
      Effect.map((next) =>
        (projection.turnItems ?? []).reduce(
          (ordinal, item) => Math.max(ordinal, item.ordinal + 1),
          next,
        ),
      ),
    );
