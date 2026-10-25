import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

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
        screenshots: (reply) =>
          Effect.sync(() => {
            seen.push({
              ...(reply.tool === undefined ? {} : { tool: reply.tool }),
              ...(reply.windowId === undefined ? {} : { windowId: reply.windowId }),
            });
            return withheld(JSON.parse(reply.line).id);
          }),
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
        screenshots: (reply) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(reply.line),
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
});
