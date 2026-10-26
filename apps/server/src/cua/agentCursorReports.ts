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
import type {
  ComputerUseAgentCursor,
  ComputerUseCursorEvent,
  ComputerUseCursorReport,
  ComputerUseOverlayCommand,
} from "@goat/contracts";
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

/** Retains the last observed point for a positionless in-flight phase on the same owner. */
export const scopedCursorReport = (
  event: ComputerUseCursorEvent,
  previous?: ComputerUseCursorReport,
): ComputerUseCursorReport => {
  const sameOwner = previous !== undefined &&
    previous.identity.environmentId === event.identity.environmentId &&
    previous.identity.runId === event.identity.runId &&
    previous.identity.turnId === event.identity.turnId &&
    previous.identity.targetId === event.identity.targetId &&
    previous.identity.generation === event.identity.generation;
  const point = event.op === "show" && event.point && event.windowId !== undefined
    ? { windowId: event.windowId, point: event.point, phase: event.phase }
    : event.op === "show" && sameOwner && previous.cursor !== null
      ? { ...previous.cursor, phase: event.phase }
      : null;
  return { identity: event.identity, phase: event.phase, cursor: point };
};

/** A sliding report queue keeps the newest scoped tombstone when intermediate positions coalesce. */
export const makeScopedAgentCursorReports = Effect.fn("agentCursorReports.scoped")(function* (
  send: (report: ComputerUseCursorReport) => Effect.Effect<boolean>,
) {
  const latest = yield* Queue.sliding<ComputerUseCursorReport>(1);
  let previous: ComputerUseCursorReport | undefined;
  yield* Stream.fromQueue(latest).pipe(
    Stream.runForEach((report) =>
      send(report).pipe(Effect.ignore, Effect.andThen(Effect.sleep(REPORT_INTERVAL))),
    ),
    Effect.forkScoped,
  );
  return (event: ComputerUseCursorEvent) => Effect.suspend(() => {
    if (previous !== undefined &&
      event.identity.environmentId === previous.identity.environmentId &&
      event.identity.runId === previous.identity.runId &&
      event.identity.turnId === previous.identity.turnId &&
      event.identity.targetId === previous.identity.targetId &&
      event.identity.generation === previous.identity.generation &&
      event.identity.sequence <= previous.identity.sequence) return Effect.void;
    const report = scopedCursorReport(event, previous);
    previous = report;
    return Queue.offer(latest, report).pipe(Effect.asVoid);
  });
});

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
        `${"identity" in command ? `${command.identity.environmentId}:${command.identity.runId}:${command.identity.turnId}:${command.identity.targetId}:${command.identity.generation}:${command.identity.sequence}` : "legacy"}:` +
        (cursor === null
          ? `hide:${command.op === "hide" ? command.reason : "no-point"}`
          : `${cursor.windowId}:${cursor.point.fx}:${cursor.point.fy}:${cursor.phase}`);
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
  sendScoped?: (report: ComputerUseCursorReport) => Effect.Effect<boolean>,
) {
  const report = yield* makeAgentCursorReports(send);
  const scopedReport = sendScoped ? yield* makeScopedAgentCursorReports(sendScoped) : undefined;
  let state = initialOverlayState;
  return {
    draw: Effect.fn("ComputerUseLeaseProxy.overlay")(function* (event: OverlayEvent) {
      const [next, commands] = overlayStep(state, event);
      state = next;
      const draw = sink();
      if (event.type === "cursor" && scopedReport) yield* scopedReport(event.event);
      for (const command of commands) {
        if (next.scoped === undefined || (command.op === "hide" && command.reason === "capture"))
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
