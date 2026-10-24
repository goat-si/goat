// @effect-diagnostics nodeBuiltinImport:off -- A Node duplex stands in for the helper's fd 3.
import * as NodeStream from "node:stream";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { OVERLAY_ACK_TIMEOUT_MS, overlayChannel } from "./overlayChannel.ts";

/** A helper end that records each line and acks it unless told to stay silent. */
function helperEnd(answer: boolean) {
  const lines: Array<{ seq: number; command: unknown }> = [];
  const socket: NodeStream.Duplex = new NodeStream.Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        const message = JSON.parse(line) as { seq: number; command: unknown };
        lines.push(message);
        if (answer) socket.push(JSON.stringify({ ack: message.seq }) + "\n");
      }
      callback();
    },
  });
  return { socket, lines };
}

const hide = { op: "hide", reason: "capture" } as const;

describe("overlayChannel", () => {
  it.effect("returns once the helper acks that command", () =>
    Effect.gen(function* () {
      const helper = helperEnd(true);
      const send = overlayChannel(helper.socket);
      yield* send(hide);
      yield* send({ op: "hide", reason: "idle" });
      assert.deepEqual(helper.lines, [
        { seq: 1, command: hide },
        { seq: 2, command: { op: "hide", reason: "idle" } },
      ]);
    }),
  );

  it.effect("goes on after the timeout when the helper never answers", () =>
    Effect.gen(function* () {
      const helper = helperEnd(false);
      const fiber = yield* overlayChannel(helper.socket)(hide).pipe(Effect.forkChild);
      yield* TestClock.adjust(OVERLAY_ACK_TIMEOUT_MS - 1);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      yield* Fiber.join(fiber);
      assert.lengthOf(helper.lines, 1);
    }),
  );

  it.effect("passes on the helper's input reports and ignores lines it cannot read", () =>
    Effect.gen(function* () {
      const helper = helperEnd(true);
      const seen: Array<unknown> = [];
      const last = yield* Deferred.make<void>();
      overlayChannel(helper.socket, (input) => {
        seen.push(input);
        if (input.source === "pointer") Deferred.doneUnsafe(last, Effect.void);
      });
      helper.socket.push(JSON.stringify({ humanInput: { source: "typed text", ageMs: 1 } }) + "\n");
      helper.socket.push("not json\n");
      helper.socket.push(JSON.stringify({ humanInput: { source: "keyboard", ageMs: 120 } }) + "\n");
      // Lines are read in order, so the last one arriving means every earlier one was handled.
      helper.socket.push(JSON.stringify({ humanInput: { source: "pointer", ageMs: 0 } }) + "\n");
      yield* Deferred.await(last);
      assert.deepEqual(seen, [
        { source: "keyboard", ageMs: 120 },
        { source: "pointer", ageMs: 0 },
      ]);
    }),
  );

  it.effect("sends nothing and returns at once once the helper is gone", () =>
    Effect.gen(function* () {
      const helper = helperEnd(true);
      helper.socket.destroy();
      yield* overlayChannel(helper.socket)(hide);
      assert.lengthOf(helper.lines, 0);
    }),
  );
});
