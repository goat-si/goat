import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { call, foregroundActive, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const treeReply = (id: number, rows: string) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: `window_id=7 pid=42\n${rows}` }] },
  });
const done = (id: number) =>
  JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }] } });
const foregroundClick = (id: number) =>
  call(id, "click", { pid: 42, window_id: 7, x: 256, y: 100, delivery_mode: "foreground" });

describe("lease proxy token first", () => {
  it.effect(
    "refuses a foreground click on a window whose last read offered tokens nobody tried, so the person's cursor stays put",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(foregroundActive());
        yield* h.send(call(1, "get_window_state", { pid: 42, window_id: 7 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.reply(treeReply(1, '- [0] AXWindow "Chats"\n  - [2] AXCell'));
        yield* h.nextToProvider;

        yield* h.send(foregroundClick(2));
        const refused = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
          isError: boolean;
        };
        assert.equal(refused.structuredContent.detail, "token_first");
        assert.isTrue(refused.isError);
        assert.equal(yield* h.driverQueued, 0);

        // A background token attempt on that window lifts it: foreground is the next rung.
        yield* h.send(call(3, "click", { pid: 42, window_id: 7, element_token: "s1:2" }));
        assert.equal((yield* h.nextToDriver).id, 3);
        yield* h.reply(done(3));
        yield* h.nextToProvider;
        yield* h.send(foregroundClick(4));
        assert.equal((yield* h.nextToDriver).id, 4);
      }),
  );

  it.effect("lets a foreground click through when the window's read offered no tokens", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(foregroundActive());
      yield* h.send(call(1, "get_window_state", { pid: 42, window_id: 7 }));
      yield* h.nextToDriver;
      yield* h.reply(treeReply(1, "elements=0 (canvas)"));
      yield* h.nextToProvider;
      yield* h.send(foregroundClick(2));
      assert.equal((yield* h.nextToDriver).id, 2);
    }),
  );

  it.effect("counts a keyboard action on the window as the background attempt", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(foregroundActive());
      yield* h.send(call(1, "get_window_state", { pid: 42, window_id: 7 }));
      yield* h.nextToDriver;
      yield* h.reply(treeReply(1, "  - [2] AXCell"));
      yield* h.nextToProvider;
      yield* h.send(call(2, "press_key", { pid: 42, window_id: 7, key: "return" }));
      yield* h.nextToDriver;
      yield* h.reply(done(2));
      yield* h.nextToProvider;
      yield* h.send(foregroundClick(3));
      assert.equal((yield* h.nextToDriver).id, 3);
    }),
  );
});
