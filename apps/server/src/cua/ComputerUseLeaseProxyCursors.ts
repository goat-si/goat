import type { AgentCursorEvent, AgentCursorLeaseUpdate } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { OverlayEvent } from "./ComputerUseOverlay.ts";

/** Closes the driver chain for a target that turned private or was taken over. */
export interface TargetClose {
  /** Synchronous, so no call reaches that chain once the hide is accepted. */
  readonly fenceTarget: (reason: "private" | "takeover", connectionId: string) => void;
  readonly closeTarget: (
    reason: "private" | "takeover",
    connectionId: string,
  ) => Effect.Effect<void>;
}

const closingReason = (event: AgentCursorEvent) =>
  event.op === "hide" && (event.reason === "private" || event.reason === "takeover")
    ? event.reason
    : undefined;

/** Cursor drawing cannot hold the lease reader or change driver admission. */
export const forwardProxyCursors = (input: {
  readonly events: Stream.Stream<AgentCursorLeaseUpdate> | undefined;
  readonly controlId: string;
  readonly connectionId: () => string | undefined;
  readonly active: () => boolean;
  readonly overlay: {
    readonly draw: (command: OverlayEvent) => Effect.Effect<void>;
    readonly accepts: (event: AgentCursorEvent) => boolean;
  };
  readonly targetClose: () => TargetClose;
}) =>
  input.events === undefined
    ? Effect.void
    : input.events.pipe(
        Stream.runForEach((update) => {
          if (
            update.controlId !== input.controlId ||
            update.connectionGeneration !== input.connectionId() ||
            !input.active()
          )
            return Effect.void;
          // The helper keeps its session for a target's hide (its reason reads "idle"), so a
          // window that turned private or was taken over gets a new driver chain instead.
          const reason = closingReason(update.event);
          const closes = reason !== undefined && input.overlay.accepts(update.event);
          if (closes) input.targetClose().fenceTarget(reason, update.connectionGeneration);
          return input.overlay
            .draw({ type: "cursor", event: update.event })
            .pipe(
              Effect.andThen(
                closes
                  ? input.targetClose().closeTarget(reason, update.connectionGeneration)
                  : Effect.void,
              ),
            );
        }),
        Effect.forkScoped,
        Effect.asVoid,
      );
