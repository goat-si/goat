import type { AgentCursorLeaseUpdate } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { OverlayEvent } from "./ComputerUseOverlay.ts";

/** Cursor drawing cannot hold the lease reader or change driver admission. */
export const forwardProxyCursors = (input: {
  readonly events: Stream.Stream<AgentCursorLeaseUpdate> | undefined;
  readonly controlId: string;
  readonly connectionId: () => string | undefined;
  readonly active: () => boolean;
  readonly draw: (command: OverlayEvent) => Effect.Effect<void>;
}) =>
  input.events === undefined
    ? Effect.void
    : input.events.pipe(
        Stream.runForEach((update) =>
          update.controlId === input.controlId &&
          update.connectionGeneration === input.connectionId() &&
          input.active()
            ? input.draw({ type: "cursor", event: update.event })
            : Effect.void,
        ),
        Effect.forkScoped,
        Effect.asVoid,
      );
