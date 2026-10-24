import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy telling a person's input from the agent's", () => {
  it.effect("a person's key during the agent's own click reaches the server", () =>
    Effect.gen(function* () {
      const h = yield* harness({ humanInput: true });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      // A click posts pointer events; a keyboard event while it runs is someone else's.
      yield* h.hid("keyboard");
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      yield* h.nextToProvider;
      yield* TestClock.adjust(2_000);
      yield* h.hid("pointer");
      assert.equal(yield* h.person, "keyboard");
    }),
  );

  it.effect("a call reaches the driver only after the server has its start", () =>
    Effect.gen(function* () {
      const agentInputGate = yield* Deferred.make<void>();
      const h = yield* harness({ humanInput: true, agentInputGate });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal(yield* h.agentCall, "start 1");
      // Another agent's helper may see this click's events: the server must already know it.
      assert.equal(yield* h.driverQueued, 0);
      yield* Deferred.succeed(agentInputGate, undefined);
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      yield* h.nextToProvider;
      assert.equal(yield* h.agentCall, "end 1");
    }),
  );
});
