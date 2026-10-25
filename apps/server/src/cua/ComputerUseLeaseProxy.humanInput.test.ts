import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  active,
  call,
  CONTROL,
  harness,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

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

  it.effect("a settle wait posts no input, so a person's keys and pointer stay a person's", () =>
    Effect.gen(function* () {
      // The server's first accepted event pauses the child, so each kind gets its own run.
      for (const source of ["keyboard", "pointer"] as const) {
        // Never released: a call that reported an agent input start would wait here.
        const agentInputGate = yield* Deferred.make<void>();
        const h = yield* harness({ humanInput: true, agentInputGate });
        yield* h.push(active());
        yield* h.send(call(1, "wait_for_window_settle", { pid: 4, window_id: 9 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.hid(source);
        assert.equal(yield* h.person, source);
      }
    }),
  );

  it.effect("a call whose start report a pause overtook never reaches the next driver", () =>
    Effect.gen(function* () {
      const agentInputGate = yield* Deferred.make<void>();
      const h = yield* harness({ humanInput: true, agentInputGate });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal(yield* h.agentCall, "start 1");
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      yield* h.killed;
      yield* h.push(active());
      yield* h.restarted;
      yield* Deferred.succeed(agentInputGate, undefined);
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 1);
      assert.deepInclude(answer.result.structuredContent, { detail: "waiting_for_human" });
      assert.notProperty(answer.result.structuredContent, "effect");
      // Its start is closed again, after the start, so it hides nobody's input.
      assert.equal(yield* h.agentCall, "end 1");
      yield* h.send(call(2, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 2);
    }),
  );
});
