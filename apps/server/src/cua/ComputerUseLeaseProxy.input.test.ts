import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy person and agent input", () => {
  it.effect(
    "reports a person's input once, and never the agent's own input during or just after its call",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ humanInput: true });
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        // The click's own events, while it runs and as they surface after its answer.
        yield* h.hid("pointer");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        yield* h.nextToProvider;
        yield* h.hid("pointer");
        yield* TestClock.adjust(1_000);
        // Reported a second late, but from the click's moment.
        yield* h.hid("pointer", 800);
        // A person's key well after the click: the first thing that reaches the server.
        yield* h.hid("keyboard");
        assert.equal(yield* h.person, "keyboard");
      }),
  );

  it.effect("a report the server did not take is offered again with the next event", () =>
    Effect.gen(function* () {
      let accepted = false;
      const h = yield* harness({ humanInput: true, acceptHuman: () => accepted });
      yield* h.push(active());
      yield* h.hid("keyboard");
      assert.equal(yield* h.person, "keyboard");
      accepted = true;
      yield* h.hid("pointer");
      assert.equal(yield* h.person, "pointer");
    }),
  );

  it.effect("tells the server when each call that can post input starts and ends", () =>
    Effect.gen(function* () {
      const h = yield* harness({ humanInput: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      yield* h.nextToDriver;
      yield* h.send(call(2, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      yield* h.nextToDriver;
      assert.equal(yield* h.agentCall, "start 2");
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
      yield* h.nextToProvider;
      assert.equal(yield* h.agentCall, "end 2");
    }),
  );

  it.effect("a call that only reads never hides a person's input", () =>
    Effect.gen(function* () {
      const h = yield* harness({ humanInput: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.hid("pointer");
      assert.equal(yield* h.person, "pointer");
    }),
  );

  it.effect.each(["reply", "cancel", "stop", "pause", "child exits"] as const)(
    "ends a sent input call exactly once on %s, including after a late reply or replacement",
    (ending) =>
      Effect.gen(function* () {
        const h = yield* harness({ humanInput: true });
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        assert.equal(yield* h.agentCall, "start 1");
        const reply = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } });
        if (ending === "reply") {
          yield* h.reply(reply);
          assert.equal((yield* h.nextToProvider).id, 1);
        } else if (ending === "cancel") {
          yield* h.send(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: 1 },
            }),
          );
          assert.equal((yield* h.nextToDriver).method, "notifications/cancelled");
        } else {
          if (ending === "pause")
            yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
          else if (ending === "stop") yield* h.push({ state: "ended", reason: "stopped" });
          else yield* h.driverExits;
          assert.equal((yield* h.nextToProvider).id, 1);
        }
        assert.equal(yield* h.agentCall, "end 1");

        if (ending === "stop" || ending === "child exits") {
          yield* h.send(call(2, "click"));
          assert.equal((yield* h.nextToProvider).id, 2);
          assert.equal(yield* h.agentCallsQueued, 0);
          return;
        }
        if (ending === "pause") {
          yield* h.push(active());
          yield* h.restarted;
        }
        // A cancelled or already answered call cannot end twice, even on a new child.
        yield* h.reply(reply);
        yield* h.send(call(2, "click", { pid: 4, window_id: 9, x: 2, y: 2 }));
        assert.equal((yield* h.nextToDriver).id, 2);
        assert.equal(yield* h.agentCall, "start 2");
        yield* h.push({ state: "ended", reason: "stopped" });
        assert.equal((yield* h.nextToProvider).id, 2);
        assert.equal(yield* h.agentCall, "end 2");
        assert.equal(yield* h.agentCallsQueued, 0);
      }),
  );
});
