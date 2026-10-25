import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";

import { makeHelperInputFeed } from "./agentInputReports.ts";
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

  it.effect(
    "events that arrive behind a slow report go to the server together, so a burst costs a few reports, not one per event",
    () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const h = yield* harness({ humanInput: true, acceptHuman: () => false, humanGate: gate });
        yield* h.push(active());
        yield* h.hid("pointer");
        assert.equal(yield* h.person, "pointer");
        // A pointer moving at 120 Hz for a third of a second while the server is slow, then a key.
        for (let move = 0; move < 40; move++)
          yield* TestClock.adjust(8).pipe(Effect.andThen(h.hid("pointer")));
        yield* TestClock.adjust(8).pipe(Effect.andThen(h.hid("keyboard")));
        yield* Deferred.succeed(gate, undefined);
        const reported: Array<string> = [];
        while (reported.at(-1) !== "keyboard") reported.push(yield* h.person);
        assert.lengthOf(reported, 41);
        // The first event, then the burst; an event still on its way into the proxy when the
        // server answers goes in the report after.
        const batches = yield* h.humanBatches;
        assert.isAtMost(batches.length, 3, String(batches));
        assert.equal(
          batches.reduce((sum, batch) => sum + batch.sources.length, 0),
          42,
        );
      }),
  );

  it.effect(
    "the helper feed keeps every line one socket chunk hands over, a person's key included",
    () =>
      Effect.gen(function* () {
        const feed = yield* makeHelperInputFeed();
        // The overlay channel hands every line of a chunk over before anything else runs.
        const lines = [
          "pointer",
          "keyboard",
          ...Array.from({ length: 38 }, () => "pointer"),
        ] as const;
        for (const [index, source] of lines.entries()) feed.offer({ source, at: index });
        const last = lines.length - 1;
        const kept = yield* feed.events.pipe(
          Stream.takeUntil((event) => event.at === last),
          Stream.runCollect,
        );
        assert.deepEqual(
          kept.map((event) => event.source),
          [...lines],
        );
      }),
  );

  it.effect(
    "under a sustained stream and a slow server, a person's key goes in the report after the one in flight",
    () =>
      Effect.gen(function* () {
        // 1.9 s per report, just under the CLI's 2 s timeout, and moves at 250 a second.
        const h = yield* harness({
          humanInput: true,
          acceptHuman: () => false,
          reportDelay: 1_900,
        });
        yield* h.push(active());
        for (let tick = 0; tick < 2_000; tick++) {
          yield* TestClock.adjust(4);
          yield* h.hid(tick === 1_250 ? "keyboard" : "pointer");
        }
        yield* TestClock.adjust(20_000);
        const batches = yield* h.humanBatches;
        const sent = batches.find((batch) => batch.sources.includes("keyboard"));
        assert.isDefined(sent, "the key was never reported");
        // The key happened at 5 s; the report out then ends by 6.9 s at the latest.
        assert.isAtMost(sent?.at ?? Infinity, 5_000 + 1_900, String(sent?.at));
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
