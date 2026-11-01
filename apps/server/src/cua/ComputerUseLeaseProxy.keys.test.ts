// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { active, call, harness as makeHarness } from "./ComputerUseLeaseProxy.testkit.ts";

const harness = (options: Parameters<typeof makeHarness>[0] = {}) =>
  makeHarness({ autoAppListing: true, ...options });

const window = { pid: 4, window_id: 9 };

describe("key names are checked after the request's own envelope and id", () => {
  it.effect("an unknown key under an id still in progress gets the in-progress refusal", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.applied;
      yield* h.send(call(1, "click", { ...window, x: 1, y: 1 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.send(call(1, "press_key", { ...window, key: "notakey" }));
      const answer = JSON.stringify(yield* h.nextToProvider);
      assert.include(answer, "work in progress");
      assert.notInclude(answer, "Unknown key name");
    }),
  );

  it.effect("a malformed envelope is refused as such even when its key is unknown", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.applied;
      yield* h.send(
        JSON.stringify({
          id: 2,
          method: "tools/call",
          params: { name: "press_key", arguments: { ...window, key: "notakey" } },
        }),
      );
      assert.notInclude(JSON.stringify(yield* h.nextToProvider), "Unknown key name");
    }),
  );
});
