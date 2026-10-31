import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { makeOverlayDrawer, makeScopedAgentCursorReports } from "./agentCursorReports.ts";
import {
  EnvironmentId,
  type AgentCursorReport,
  type ComputerUseOverlayCommand,
} from "@goat/contracts";

/** A PNG header the proxy reads the screenshot size from. */
const pngOf = (width: number, height: number) => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png.toString("base64");
};

describe("agent cursor reports", () => {
  it.effect("posts a screen lock notice only while the overlay is showing", () =>
    Effect.gen(function* () {
      const posted: ComputerUseOverlayCommand[] = [];
      const sink = Object.assign((_command: ComputerUseOverlayCommand) => Effect.void, {
        post: (command: ComputerUseOverlayCommand) => Effect.sync(() => void posted.push(command)),
      });
      const drawer = yield* makeOverlayDrawer(undefined, () => sink);
      yield* drawer.draw({ type: "call", id: "1", name: "click", args: { pid: 4, window_id: 9 } });
      yield* drawer.screenLocked();
      assert.deepEqual(posted.at(-1), { op: "status", message: "screen locked" });
      yield* drawer.draw({ type: "pause", reason: "screen_locked" });
      yield* drawer.screenLocked();
      assert.equal(posted.filter((command) => command.op === "status").length, 1);
    }),
  );
  it.effect("a show does not wait for the helper's ack, and a capture's hide does", () =>
    Effect.gen(function* () {
      const posted: Array<string> = [];
      const waited: Array<string> = [];
      const gate = yield* Deferred.make<void>();
      const sink = Object.assign(
        (command: { readonly op: string }) =>
          Effect.sync(() => void waited.push(command.op)).pipe(
            Effect.andThen(Deferred.await(gate)),
          ),
        {
          post: (command: { readonly op: string }) =>
            Effect.sync(() => void posted.push(command.op)),
        },
      );
      const drawer = yield* makeOverlayDrawer(undefined, () => sink as never, undefined);
      yield* drawer.draw({
        type: "call",
        id: "1",
        name: "click",
        args: { pid: 4, window_id: 9, element_token: "s1:1" },
      });
      assert.deepEqual(posted, ["show"]);
      assert.deepEqual(waited, []);
      const capture = yield* drawer
        .draw({ type: "call", id: "2", name: "get_window_state", args: { pid: 4, window_id: 9 } })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 millis");
      assert.deepEqual(waited, ["hide"]);
      assert.isUndefined(capture.pollUnsafe());
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(capture);
    }),
  );
  it.effect("a late phase of an older owner does not take the preview from the current one", () =>
    Effect.gen(function* () {
      const reports: AgentCursorReport[] = [];
      const drawer = yield* makeOverlayDrawer(
        undefined,
        () => undefined,
        (report) => Effect.sync(() => reports.push(report) > 0),
      );
      const older = {
        environmentId: EnvironmentId.make("environment"),
        runId: "run",
        turnId: "turn",
        targetId: "a",
        generation: 1,
      };
      const current = { ...older, targetId: "b", generation: 2 };
      yield* drawer.draw({
        type: "cursor",
        event: { op: "show", identity: { ...current, sequence: 1 }, phase: "thinking" },
      });
      // The overlay refuses this: a newer owner is showing.
      yield* drawer.draw({
        type: "cursor",
        event: { op: "show", identity: { ...older, sequence: 5 }, phase: "resting" },
      });
      yield* drawer.draw({
        type: "call",
        id: "1",
        name: "click",
        args: { pid: 4, window_id: 9, element_token: "s1:1" },
        codeMode: true,
        cursor: { owner: { ...current, sequence: 0 }, point: { fx: 0.5, fy: 0.45 } },
      });
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(reports.at(-1), {
        identity: { ...current, sequence: 1 },
        phase: "thinking",
        cursor: { windowId: 9, point: { fx: 0.5, fy: 0.45 }, phase: "acting" },
      });
    }),
  );
  it.effect("a scoped preview report carries the point the overlay drew for that owner", () =>
    Effect.gen(function* () {
      const reports: AgentCursorReport[] = [];
      const drawer = yield* makeOverlayDrawer(
        undefined,
        () => undefined,
        (report) => Effect.sync(() => reports.push(report) > 0),
      );
      const owner = {
        environmentId: EnvironmentId.make("environment"),
        runId: "run",
        turnId: "turn",
        targetId: "target",
        generation: 1,
      };
      const phase = (sequence: number, next: "thinking" | "resting") =>
        drawer.draw({
          type: "cursor",
          event: { op: "show", identity: { ...owner, sequence }, phase: next },
        });
      yield* phase(1, "thinking");
      // The host's element point rides on the driver call; the owner's own events have none.
      yield* drawer.draw({
        type: "call",
        id: "1",
        name: "click",
        args: { pid: 4, window_id: 9, element_token: "s1:1" },
        codeMode: true,
        cursor: { owner: { ...owner, sequence: 0 }, point: { fx: 0.5, fy: 0.45 } },
      });
      // The point reaches the preview during the action, beside the owner's thinking phase.
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(reports.at(-1)?.cursor, {
        windowId: 9,
        point: { fx: 0.5, fy: 0.45 },
        phase: "acting",
      });
      yield* drawer.draw({ type: "reply", id: "1" });
      yield* phase(2, "resting");
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(reports.at(-1)?.cursor, {
        windowId: 9,
        point: { fx: 0.5, fy: 0.45 },
        phase: "resting",
      });
      // Same-window rebind in the same turn with matching pid/windowId retains the point.
      const rebound = { ...owner, targetId: "target-2", generation: 2 };
      yield* drawer.draw({
        type: "cursor",
        event: {
          op: "show",
          identity: { ...rebound, sequence: 1 },
          phase: "thinking",
          pid: 4,
          windowId: 9,
        },
      });
      yield* TestClock.adjust("250 millis");
      assert.deepEqual(reports.at(-1)?.cursor, {
        windowId: 9,
        point: { fx: 0.5, fy: 0.45 },
        phase: "thinking",
      });
      // Different turn authority clears the point on a positionless phase.
      const otherTurn = { ...owner, turnId: "turn-2", targetId: "target-3", generation: 3 };
      yield* drawer.draw({
        type: "cursor",
        event: {
          op: "show",
          identity: { ...otherTurn, sequence: 1 },
          phase: "thinking",
        },
      });
      yield* TestClock.adjust("250 millis");
      assert.isNull(reports.at(-1)?.cursor);
    }),
  );
  it.effect(
    "coalesces intermediate positions but delivers the newest identity-bearing tombstone",
    () =>
      Effect.gen(function* () {
        const first = yield* Deferred.make<void>();
        const sent: Array<{ phase: string; sequence: number; cursor: unknown }> = [];
        const emit = yield* makeScopedAgentCursorReports((report) =>
          Effect.sync(() => {
            sent.push({
              phase: report.phase,
              sequence: report.identity.sequence,
              cursor: report.cursor,
            });
            if (sent.length === 1) Deferred.doneUnsafe(first, Effect.void);
            return true;
          }),
        );
        const owner = {
          environmentId: EnvironmentId.make("environment"),
          runId: "run",
          turnId: "turn",
          targetId: "target",
          generation: 1,
        };
        yield* emit({
          op: "show",
          identity: { ...owner, sequence: 1 },
          phase: "moving",
          pid: 4,
          windowId: 9,
          point: { fx: 0.1, fy: 0.2 },
        });
        yield* Deferred.await(first);
        yield* emit({
          op: "show",
          identity: { ...owner, sequence: 2 },
          phase: "moving",
          pid: 4,
          windowId: 9,
          point: { fx: 0.4, fy: 0.5 },
        });
        yield* emit({
          op: "hide",
          identity: { ...owner, sequence: 3 },
          phase: "hidden",
          reason: "ended",
        });
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(
          sent.map(({ phase, sequence }) => ({ phase, sequence })),
          [
            { phase: "moving", sequence: 1 },
            { phase: "hidden", sequence: 3 },
          ],
        );
        assert.isNull(sent[1]?.cursor);
      }),
  );

  it.effect(
    "tells the preview where the overlay draws the cursor, at most four times a second",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ overlay: true, cursors: true });
        yield* h.push(active());
        const window = { pid: 4, window_id: 9 };
        yield* h.send(call(1, "get_window_state", window));
        yield* h.nextToDriver;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "image", mimeType: "image/png", data: pngOf(1000, 500) }] },
          }),
        );
        yield* h.nextToProvider;
        // The capture hid the overlay: nothing to point at yet.
        assert.deepEqual(h.cursors, [null]);
        yield* h.send(call(2, "click", { ...window, x: 500, y: 250 }));
        yield* h.nextToDriver;
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
        yield* h.nextToProvider;
        // Acting then resting arrived inside one interval: only the newest goes out after it.
        assert.deepEqual(h.cursors, [null]);
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(h.cursors, [
          null,
          { windowId: 9, point: { fx: 0.5, fy: 0.5 }, phase: "resting" },
        ]);
        // A capture hides the cursor again, and the preview hears it.
        yield* h.send(call(3, "get_window_state", window));
        yield* h.nextToDriver;
        yield* TestClock.adjust("250 millis");
        assert.deepEqual(h.cursors.at(-1), null);
      }),
  );
});
