import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAppGuide } from "./ComputerUseGuide.ts";
import { call, foregroundActive, harness } from "./ComputerUseLeaseProxy.testkit.ts";

describe("lease proxy launch guidance", () => {
  const launchedWithoutWindow = (id: number, pid: number) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        content: [],
        structuredContent: {
          pid,
          launch_state: { requested: true, process_running: true, window_ready: false },
          windows: [],
        },
      },
    });
  const told = (answer: Record<string, unknown>) => JSON.stringify(answer.result);

  it.effect(
    "tells each windowless launch, answered out of order, to list its own app's windows",
    () =>
      Effect.gen(function* () {
        const h = yield* harness({ guide: makeAppGuide("darwin", undefined) });
        yield* h.push(foregroundActive());
        yield* h.applied;
        yield* h.send(call(1, "launch_app", { bundle_id: "com.apple.calculator" }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.nextReservation;
        yield* h.send(call(2, "launch_app", { bundle_id: "com.apple.TextEdit" }));
        assert.equal((yield* h.nextToDriver).id, 2);
        yield* h.nextReservation;
        // A list_apps answer shaped like a launch is not one; only the request decides.
        yield* h.send(call(3, "list_apps"));
        assert.equal((yield* h.nextToDriver).id, 3);
        yield* h.reply(launchedWithoutWindow(2, 52));
        yield* h.reply(launchedWithoutWindow(3, 63));
        yield* h.reply(launchedWithoutWindow(1, 41));
        const answers = [yield* h.nextToProvider, yield* h.nextToProvider, yield* h.nextToProvider];
        assert.deepEqual(
          answers.map((answer) => answer.id),
          [2, 3, 1],
        );
        assert.include(told(answers[0]!), "list_windows({ pid: 52 })");
        assert.notInclude(told(answers[0]!), "pid: 41");
        assert.notInclude(told(answers[1]!), "list_windows");
        assert.include(told(answers[2]!), "list_windows({ pid: 41 })");
        assert.notInclude(told(answers[2]!), "pid: 52");
      }),
  );

  it.effect("a cancelled or unknown launch reply reaches the agent with no launch note", () =>
    Effect.gen(function* () {
      const h = yield* harness({ guide: makeAppGuide("darwin", undefined) });
      yield* h.push(foregroundActive());
      yield* h.applied;
      yield* h.send(call(1, "launch_app", { bundle_id: "com.apple.calculator" }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.nextReservation;
      yield* h.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
      );
      yield* h.nextToDriver;
      yield* h.reply(launchedWithoutWindow(1, 41));
      yield* h.reply(launchedWithoutWindow(99, 42));
      yield* h.send(call(2, "list_apps"));
      assert.equal((yield* h.nextToDriver).id, 2);
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [] } }));
      const answer = yield* h.nextToProvider;
      assert.equal(answer.id, 2);
      assert.notInclude(JSON.stringify(answer), "list_windows");
    }),
  );
});
