import {
  applyOrchestrationV2ThreadVisit,
  type OrchestrationV2ThreadStreamItem,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;

export const withLegacyThreadVisits =
  (
    input: { readonly acceptCompactVisits?: boolean },
    threads: Pick<ThreadManagementServiceShape, "getThreadRecords">,
  ) =>
  <E, R>(stream: Stream.Stream<ThreadEvent, E, R>) =>
    input.acceptCompactVisits === true
      ? stream
      : stream.pipe(
          Stream.mapEffect((item) => {
            const { event } = item;
            if (event.type !== "thread.visit-recorded") return Effect.succeed(item);
            return threads.getThreadRecords(event.threadId, []).pipe(
              Effect.map(({ thread }) => ({
                ...item,
                event: {
                  ...event,
                  type: "thread.visited" as const,
                  payload: applyOrchestrationV2ThreadVisit(thread, event.payload),
                },
              })),
            );
          }),
        );
