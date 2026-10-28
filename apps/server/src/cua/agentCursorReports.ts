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
  AgentCursorEvent,
  AgentCursorReport,
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

const sameScopedOwner = (a: AgentCursorReport["identity"], b: AgentCursorReport["identity"]) =>
  a.environmentId === b.environmentId &&
  a.runId === b.runId &&
  a.turnId === b.turnId &&
  a.targetId === b.targetId &&
  a.generation === b.generation;

/** Retains the last observed point for a positionless in-flight phase on the same owner. */
const scopedCursorReport = (
  event: AgentCursorEvent,
  previous?: AgentCursorReport,
): AgentCursorReport => {
  const sameOwner = previous !== undefined && sameScopedOwner(previous.identity, event.identity);
  const point =
    event.op === "show" && event.point && event.windowId !== undefined
      ? { windowId: event.windowId, point: event.point, phase: event.phase }
      : event.op === "show" && sameOwner && previous.cursor !== null
        ? { ...previous.cursor, phase: event.phase }
        : null;
  return { identity: event.identity, phase: event.phase, cursor: point };
};

/** A sliding report queue keeps the newest scoped tombstone when intermediate positions coalesce. */
export const makeScopedAgentCursorReports = Effect.fn("agentCursorReports.scoped")(function* (
  send: (report: AgentCursorReport) => Effect.Effect<boolean>,
) {
  const latest = yield* Queue.sliding<AgentCursorReport>(1);
  let previous: AgentCursorReport | undefined;
  yield* Stream.fromQueue(latest).pipe(
    Stream.runForEach((report) =>
      send(report).pipe(Effect.ignore, Effect.andThen(Effect.sleep(REPORT_INTERVAL))),
    ),
    Effect.forkScoped,
  );
  const emit = (event: AgentCursorEvent) =>
    Effect.suspend(() => {
      if (
        previous !== undefined &&
        sameScopedOwner(previous.identity, event.identity) &&
        event.identity.sequence <= previous.identity.sequence
      )
        return Effect.void;
      const report = scopedCursorReport(event, previous);
      previous = report;
      return Queue.offer(latest, report).pipe(Effect.asVoid);
    });
  /**
   * What the overlay drew for the current owner: its point, from the call that acted, replaces
   * the one the owner's positionless events would retain.
   */
  const placed = (command: ComputerUseOverlayCommand) =>
    Effect.suspend(() => {
      if (
        command.op !== "show" ||
        !("identity" in command) ||
        previous === undefined ||
        !sameScopedOwner(previous.identity, command.identity) ||
        command.identity.sequence < previous.identity.sequence
      )
        return Effect.void;
      const cursor = cursorOf(command);
      const before = previous.cursor;
      if (
        cursor === null
          ? before === null
          : before !== null &&
            before.windowId === cursor.windowId &&
            before.point.fx === cursor.point.fx &&
            before.point.fy === cursor.point.fy &&
            before.phase === cursor.phase
      )
        return Effect.void;
      const report = { identity: command.identity, phase: previous.phase, cursor };
      previous = report;
      return Queue.offer(latest, report).pipe(Effect.asVoid);
    });
  return Object.assign(emit, { placed });
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
 * and waits until the current helper (when it draws one) has drawn it. The agent can turn the
 * on-screen cursor off; hides still reach the helper, which interrupts its work on a pause or end.
 */
export const makeOverlayDrawer = Effect.fn("agentCursorReports.makeOverlayDrawer")(function* (
  send: ((cursor: ComputerUseAgentCursor | null) => Effect.Effect<boolean>) | undefined,
  sink: () => ((command: ComputerUseOverlayCommand) => Effect.Effect<void>) | undefined,
  sendScoped?: (report: AgentCursorReport) => Effect.Effect<boolean>,
) {
  const report = yield* makeAgentCursorReports(send);
  const scopedReport = sendScoped ? yield* makeScopedAgentCursorReports(sendScoped) : undefined;
  let state = initialOverlayState;
  let enabled = true;
  const toHelper = (command: ComputerUseOverlayCommand): ComputerUseOverlayCommand =>
    enabled || command.op !== "show" ? command : { op: "hide", reason: "idle" };
  return {
    draw: Effect.fn("ComputerUseLeaseProxy.overlay")(function* (event: OverlayEvent) {
      const before = state.scoped;
      const [next, commands] = overlayStep(state, event);
      state = next;
      const draw = sink();
      // Only what the overlay took: an owner's phase, or the owner a call brought ahead of its
      // phases. A late phase of an older owner the overlay refused would steal the preview.
      if (next.scoped !== before && next.scoped !== undefined && scopedReport)
        yield* scopedReport(next.scoped);
      for (const command of commands) {
        if (next.scoped === undefined || (command.op === "hide" && command.reason === "capture"))
          yield* report(command);
        else if (scopedReport) yield* scopedReport.placed(command);
        if (draw !== undefined) yield* draw(toHelper(command));
      }
    }),
    view: () => ({ enabled, visible: enabled && state.shown?.op === "show" }),
    placed: () => state.shown?.op === "show" && state.shown.point !== undefined,
    setEnabled: Effect.fn("ComputerUseLeaseProxy.setCursorEnabled")(function* (next: boolean) {
      if (next === enabled) return;
      enabled = next;
      const draw = sink();
      if (draw !== undefined && state.shown?.op === "show")
        yield* draw(next ? state.shown : toHelper(state.shown));
    }),
    /** A fresh helper draws nothing yet; the agent's choice to hide the cursor stays. */
    reset: () => {
      state = initialOverlayState;
    },
  };
});
