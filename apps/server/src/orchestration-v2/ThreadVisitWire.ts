import type { OrchestrationV2ThreadStreamItem } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ThreadLiveInput } from "./ThreadLiveEventCoalescer.ts";
type ThreadSnapshot = Extract<OrchestrationV2ThreadStreamItem, { snapshotSequence: number }>;

export const withLegacyThreadVisits =
  <SnapshotError>(
    input: { readonly acceptCompactVisits?: boolean },
    loadSnapshot: () => Effect.Effect<ThreadSnapshot, SnapshotError>,
  ) =>
  <E, R>(
    stream: Stream.Stream<ThreadLiveInput, E, R>,
  ): Stream.Stream<OrchestrationV2ThreadStreamItem, E | SnapshotError, R> =>
    input.acceptCompactVisits === true
      ? stream
      : stream.pipe(
          Stream.mapAccumEffect(
            () => 0,
            (
              snapshotSequence,
              item,
            ): Effect.Effect<
              readonly [number, ReadonlyArray<ThreadLiveInput | ThreadSnapshot>],
              SnapshotError
            > => {
              if (item.kind !== "event") return Effect.succeed([snapshotSequence, [item]]);
              if (item.sequence <= snapshotSequence) return Effect.succeed([snapshotSequence, []]);
              if (item.event.type !== "thread.visit-recorded")
                return Effect.succeed([snapshotSequence, [item]]);
              // Only the snapshot read can pair current thread state with its serving sequence.
              return Effect.map(loadSnapshot(), (snapshot) => [
                snapshot.snapshotSequence,
                [snapshot],
              ]);
            },
          ),
        );
