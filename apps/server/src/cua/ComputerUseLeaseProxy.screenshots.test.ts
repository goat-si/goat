import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { active, call, CONTROL, cutOffCall, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import {
  linuxScreenshotPolicy,
  type LinuxScreenshotPolicy,
  SCREENSHOT_FILE_REFUSED,
} from "./ComputerUseLinuxScreenshots.ts";
import { CROPPED_CAPTURE } from "./linuxHelper/windowCapture.ts";

/** A policy whose window reads go through admit, and that leaves every other line alone. */
const policy = (admit: LinuxScreenshotPolicy["admit"]): LinuxScreenshotPolicy => ({
  admit,
  scrub: (line) => line,
  refuseArguments: () => undefined,
});

const DRIVER_PNG = Buffer.from("driver pixels").toString("base64");
const windowRead = (id: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        { type: "text", text: "window tree" },
        { type: "image", mimeType: "image/png", data: DRIVER_PNG },
      ],
      structuredContent: { screenshot_width: 4, screenshot_height: 3 },
    },
  });
const withheld = (id: number) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: "GOAT withheld a screenshot from this result." }] },
  });
const images = (answer: unknown) =>
  JSON.stringify(answer).includes(DRIVER_PNG) ? ["driver image"] : [];

describe("ComputerUseLeaseProxy screenshots on Linux (#1677)", () => {
  it.effect("a window read reaches the agent only as the screenshot policy delivers it", () =>
    Effect.gen(function* () {
      const seen: Array<{ tool?: string; windowId?: number }> = [];
      const h = yield* harness({
        screenshots: policy((reply) =>
          Effect.sync(() => {
            seen.push({
              ...(reply.tool === undefined ? {} : { tool: reply.tool }),
              ...(reply.windowId === undefined ? {} : { windowId: reply.windowId }),
            });
            return withheld(JSON.parse(reply.line).id);
          }),
        ),
      });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(windowRead(1));
      const answer = yield* h.nextToProvider;
      assert.deepEqual(seen, [{ tool: "get_window_state", windowId: 9 }]);
      assert.deepEqual(images(answer), []);
      assert.include(JSON.stringify(answer), "GOAT withheld a screenshot");
    }),
  );

  it.effect("a private pause that lands while GOAT captures the window drops that read", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({
        // Passes the driver's line through once released: whatever it would have shown.
        screenshots: policy((reply) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(reply.line),
          ),
        ),
      });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(windowRead(1));
      yield* Deferred.await(entered);
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
      const answer = yield* h.nextToProvider;
      yield* Deferred.succeed(gate, undefined);
      assert.deepEqual(images(answer), []);
      assert.isTrue((answer as { result?: { isError?: boolean } }).result?.isError === true);
      // The read held at the capture never follows the pause's answer, through to the end.
      yield* h.close;
      yield* Fiber.join(h.proxy);
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect("a driver that exits while GOAT captures the window never delivers that read", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const h = yield* harness({
        screenshots: policy((reply) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(reply.line),
          ),
        ),
      });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(windowRead(1));
      yield* Deferred.await(entered);
      // The capture is still held: the exit alone answers the read.
      yield* h.driverExits;
      assert.deepEqual(yield* h.nextToProvider, cutOffCall(1, "helper_restarted", true));
      yield* Deferred.succeed(gate, undefined);
      yield* h.close;
      yield* Fiber.join(h.proxy);
      assert.equal(yield* h.providerQueued, 0);
    }),
  );

  it.effect("a call that asks the driver to write its capture to a file never reaches it", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        screenshots: linuxScreenshotPolicy({ route: "refused", reason: CROPPED_CAPTURE }),
      });
      yield* h.push(active());
      yield* h.send(
        call(1, "get_window_state", { pid: 4, window_id: 9, screenshot_out_file: "/tmp/w.png" }),
      );
      const answer = yield* h.nextToProvider;
      assert.include(JSON.stringify(answer), SCREENSHOT_FILE_REFUSED);
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("an image in the reply to any other request is withheld too", () =>
    Effect.gen(function* () {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]).toString(
        "base64",
      );
      const h = yield* harness({
        screenshots: linuxScreenshotPolicy({ route: "refused", reason: CROPPED_CAPTURE }),
      });
      yield* h.push(active());
      yield* h.send(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "s" } }),
      );
      assert.equal((yield* h.nextToDriver).id, 2);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { contents: [{ uri: "s", mimeType: "image/png", blob: png }] },
        }),
      );
      const answer = JSON.stringify(yield* h.nextToProvider);
      assert.notInclude(answer, png);
      assert.include(answer, CROPPED_CAPTURE);
    }),
  );
});

const inputError = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "failed PIXELS" }], isError: true },
});

describe("the driver's reply as delivered, after dev's unverified-input marking (#1683 merge)", () => {
  it.effect(
    "without a screenshot policy, as on macOS and Windows, the marking reaches the agent",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.reply(inputError);
        assert.include(JSON.stringify(yield* h.nextToProvider), "unverifiable");
      }),
  );

  it.effect("with the Linux policy, the marked reply still follows the screenshot rule", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        screenshots: {
          ...policy((reply) => Effect.succeed(reply.line)),
          scrub: (line) => line.replace("PIXELS", "WITHHELD"),
        },
      });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(inputError);
      const answer = JSON.stringify(yield* h.nextToProvider);
      assert.include(answer, "unverifiable");
      assert.include(answer, "failed WITHHELD");
    }),
  );
});
