import { retainedTerminalHistory, type TerminalAttachStreamEvent } from "@goat/contracts";
import type * as Effect from "effect/Effect";

type AttachListener = (event: TerminalAttachStreamEvent) => Effect.Effect<void>;

/** Sends a client that keeps `maxHistoryBytes` only that much of each snapshot's history. */
export function retainedAttachListener(
  { maxHistoryBytes }: { readonly maxHistoryBytes?: number | undefined },
  listener: AttachListener,
): AttachListener {
  if (maxHistoryBytes === undefined) return listener;
  return (event) =>
    listener(
      "snapshot" in event
        ? {
            ...event,
            snapshot: {
              ...event.snapshot,
              history: retainedTerminalHistory(event.snapshot.history, maxHistoryBytes),
            },
          }
        : event,
    );
}
