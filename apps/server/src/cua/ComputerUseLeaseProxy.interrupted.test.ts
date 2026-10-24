import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import {
  active,
  call,
  CONTROL,
  harness,
  type ToolAnswer,
} from "./ComputerUseLeaseProxy.testkit.ts";

describe("ComputerUseLeaseProxy answers for calls a pause or Stop cut off", () => {
  it.effect(
    "a click the driver already had when a person's input paused control may have acted",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
        yield* h.killed;
        const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
        assert.equal(answer.id, 1);
        assert.isTrue(answer.result.isError);
        assert.deepEqual(answer.result.structuredContent, {
          effect: "unverifiable",
          code: "interrupted",
          detail: "waiting_for_human",
        });
        const text = answer.result.content[0]?.text ?? "";
        assert.include(text, "may already have acted");
        assert.notInclude(text, "did not run");
      }),
  );

  it.effect(
    "text the driver already had when Stop came may have been typed, and the turn stops",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.push(active());
        yield* h.send(call(1, "type_text", { pid: 4, window_id: 9, text: "hello" }));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.push({ state: "ended", reason: "stopped" });
        yield* h.killed;
        const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
        assert.deepEqual(answer.result.structuredContent, {
          effect: "unverifiable",
          code: "interrupted",
          detail: "stopped",
        });
        const text = answer.result.content[0]?.text ?? "";
        assert.include(text, "may already have acted");
        assert.include(text, "Do not continue on the screen in this turn.");
      }),
  );

  it.effect("a window read cut off by a takeover says to read again, not that anything acted", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { pid: 4, window_id: 9 }));
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "takeover" });
      yield* h.killed;
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.deepEqual(answer.result.structuredContent, {
        code: "interrupted",
        detail: "waiting_for_human",
      });
      const text = answer.result.content[0]?.text ?? "";
      assert.include(text, "read again");
      assert.notInclude(text, "may already have acted");
    }),
  );

  it.effect("a call whose window report a pause overtook never reaches the next driver", () =>
    Effect.gen(function* () {
      const targetGate = yield* Deferred.make<void>();
      const h = yield* harness({ onTarget: () => true, targetGate, humanInput: true });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      yield* h.reported;
      assert.equal(yield* h.agentCallsQueued, 0);
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
      yield* h.killed;
      yield* h.push(active());
      yield* h.restarted;
      yield* Deferred.succeed(targetGate, undefined);
      // It never reached a driver, so it is a refusal: nothing was sent.
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 1);
      assert.deepInclude(answer.result.structuredContent, { detail: "waiting_for_human" });
      assert.notProperty(answer.result.structuredContent, "effect");
      assert.equal(yield* h.agentCallsQueued, 0);
      yield* h.send(call(2, "click", { pid: 4, window_id: 9, x: 1, y: 1 }));
      assert.equal((yield* h.nextToDriver).id, 2);
      assert.equal(yield* h.agentCall, "start 2");
    }),
  );
});

describe("ComputerUseLeaseProxy answers for sent calls whose reply it cannot show", () => {
  const proveScreen = (h: Effect.Success<ReturnType<typeof harness>>) =>
    Effect.gen(function* () {
      const asked = yield* h.nextToDriver;
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: asked.id,
          result: { content: [], structuredContent: { windows: [{ pid: 10, window_id: 20 }] } },
        }),
      );
    });

  it.effect.each([
    ["names a window on another display", { windows: [{ pid: 900, window_id: 5 }] }],
    ["names a window without its pid", { windows: [{ window_id: 5 }] }],
  ] as const)("a click whose reply %s may have acted and is never retried", ([, content]) =>
    Effect.gen(function* () {
      const h = yield* harness({ elsewhere: new Set([900]) });
      yield* h.push(active());
      yield* h.send(call(1, "click", { pid: 10, window_id: 20, x: 1, y: 1 }));
      yield* proveScreen(h);
      assert.equal((yield* h.nextToDriver).id, 1);
      yield* h.reply(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [], structuredContent: content },
        }),
      );
      const answer = (yield* h.nextToProvider) as unknown as ToolAnswer;
      assert.equal(answer.id, 1);
      assert.deepEqual(answer.result.structuredContent, {
        effect: "unverifiable",
        code: "interrupted",
        detail: "wrong_display",
      });
      const text = answer.result.content[0]?.text ?? "";
      assert.include(text, "may already have acted");
      assert.notInclude(text, "did not run");
      assert.notInclude(text, "try again");
    }),
  );
});
