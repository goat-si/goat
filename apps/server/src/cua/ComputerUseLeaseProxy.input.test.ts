import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy person and agent input", () => {
  it.effect(
    "reports every helper event to the server, even during the agent's own call, since only the server sees every agent's calls",
    () =>
      Effect.gen(function* () {
        // The server takes each one for an agent's: another agent may have a run of cover that,
        // with this one's, lasts past the cap, and only the server can tell.
        const h = yield* harness({ humanInput: true, acceptHuman: () => false });
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.hid("pointer");
        assert.equal(yield* h.person, "pointer");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        yield* h.nextToProvider;
        yield* h.hid("pointer");
        assert.equal(yield* h.person, "pointer");
        yield* h.hid("keyboard");
        assert.equal(yield* h.person, "keyboard");
      }),
  );

  it.effect(
    "every event waiting behind a slow report reaches the server in order, a person's key included",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({ humanInput: true, acceptHuman: () => false, humanGate: gate });
        yield* h.push(active());
        yield* h.hid("pointer");
        // The server holds this report while more events arrive than the helper's feed keeps.
        assert.equal(yield* h.person, "pointer");
        // Events a millisecond apart, as the helper sends them.
        const event = (source: "pointer" | "keyboard" | "unknown") =>
          TestClock.adjust(1).pipe(Effect.andThen(h.hid(source)));
        const sent: Array<"pointer" | "keyboard"> = [
          ...Array.from({ length: 20 }, () => "pointer" as const),
          // A person's key, then the agent's own keys later: the later ones must not replace it.
          "keyboard",
          ...Array.from({ length: 20 }, () => "pointer" as const),
          "keyboard",
        ];
        for (const source of sent) yield* event(source);
        yield* event("unknown");
        yield* Deferred.succeed(gate, undefined);
        const reported: Array<string> = [];
        while (reported.at(-1) !== "unknown" && reported.length <= sent.length)
          reported.push(yield* h.person);
        assert.deepEqual(reported, [...sent, "unknown"]);
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
    "ends a sent input call exactly once after %s finishes, including after a late reply or replacement",
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
          // Cancellation alone cannot prove that the driver stopped posting input.
          assert.equal(yield* h.agentCallsQueued, 0);
          yield* h.reply(reply);
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
