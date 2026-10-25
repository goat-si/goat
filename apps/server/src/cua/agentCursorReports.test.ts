import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

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
