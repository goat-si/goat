/**
 * Tells the server where the agent's cursor is, from the commands the proxy draws with, so a
 * preview can draw it over the window's live picture the way the helper draws it on screen.
 *
 * The overlay can change on every call and reply; the preview only needs the latest point, so
 * reports are paced: the newest value goes out at once, then at most one more per interval, and a
 * value superseded meanwhile is never sent.
 *
 * @module agentCursorReports
 */
import type { ComputerUseAgentCursor, ComputerUseOverlayCommand } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { initialOverlayState, type OverlayEvent, overlayStep } from "./ComputerUseOverlay.ts";

/** At most four reports a second, the pace a person can follow on a thumbnail. */
const REPORT_INTERVAL = "250 millis";

/** The cursor an overlay command draws, or null when it draws none. */
const cursorOf = (command: ComputerUseOverlayCommand): ComputerUseAgentCursor | null =>
  command.op === "show" && command.point !== undefined
    ? { windowId: command.windowId, point: command.point, phase: command.phase }
    : null;

/**
 * Starts the reporter in the caller's scope and returns where to offer each drawn command. A
 * command that draws the same cursor as the last one offered reports nothing.
 */
const makeAgentCursorReports = Effect.fn("agentCursorReports.make")(function* (
  send: ((cursor: ComputerUseAgentCursor | null) => Effect.Effect<boolean>) | undefined,
) {
  if (send === undefined) return (_command: ComputerUseOverlayCommand) => Effect.void;
  const latest = yield* Queue.sliding<ComputerUseAgentCursor | null>(1);
  let offered: string | undefined;
  yield* Stream.fromQueue(latest).pipe(
    Stream.runForEach((cursor) =>
      send(cursor).pipe(Effect.ignore, Effect.andThen(Effect.sleep(REPORT_INTERVAL))),
    ),
    Effect.forkScoped,
  );
  return (command: ComputerUseOverlayCommand) =>
    Effect.suspend(() => {
      const cursor = cursorOf(command);
      const key =
        cursor === null
          ? "none"
          : `${cursor.windowId}:${cursor.point.fx}:${cursor.point.fy}:${cursor.phase}`;
      if (key === offered) return Effect.void;
      offered = key;
      return Queue.offer(latest, cursor).pipe(Effect.asVoid);
    });
});

/**
 * The proxy's overlay: each event updates what it shows, tells the preview where the cursor is,
 * and waits until the current helper (when it draws one) has drawn it.
 */
export const makeOverlayDrawer = Effect.fn("agentCursorReports.makeOverlayDrawer")(function* (
  send: ((cursor: ComputerUseAgentCursor | null) => Effect.Effect<boolean>) | undefined,
  sink: () => ((command: ComputerUseOverlayCommand) => Effect.Effect<void>) | undefined,
) {
  const report = yield* makeAgentCursorReports(send);
  let state = initialOverlayState;
  return {
    draw: Effect.fn("ComputerUseLeaseProxy.overlay")(function* (event: OverlayEvent) {
      const [next, commands] = overlayStep(state, event);
      state = next;
      const draw = sink();
      for (const command of commands) {
        yield* report(command);
        if (draw !== undefined) yield* draw(command);
      }
    }),
    /** A fresh helper draws nothing yet. */
    reset: () => {
      state = initialOverlayState;
    },
  };
});
