import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mergeTerminal, terminalReplyState } from "./ComputerUseTerminal.ts";
import { makePersonStopFence, terminalSink } from "./ComputerUseLeaseProxyPersonStop.ts";

it("merges terminal reasons and possible input monotonically", () => {
  assert.deepEqual(mergeTerminal({}, { reason: "screen_locked" }), {
    reason: "screen_locked",
    possibleCommit: false,
  });
  assert.deepEqual(
    mergeTerminal(
      { reason: "screen_locked", possibleCommit: true },
      { reason: "stopped_by_person" },
    ),
    { reason: "stopped_by_person", possibleCommit: true },
  );
  assert.deepEqual(
    mergeTerminal(
      { reason: "stopped_by_person" },
      { reason: "screen_locked", possibleCommit: true },
    ),
    { reason: "stopped_by_person", possibleCommit: true },
  );
});

it("merges an already typed terminal reply without dropping possible input", () => {
  const reply = {
    isError: true,
    structuredContent: {
      code: "stopped_by_person",
      safety: { retryClass: "never", possibleCommit: true },
    },
  };
  assert.deepEqual(mergeTerminal({ reason: "screen_locked" }, terminalReplyState(reply)), {
    reason: "stopped_by_person",
    possibleCommit: true,
  });
});

it("does not classify ordinary successful data as a terminal reply", () => {
  const data = { structuredContent: { code: "screen_locked" } };
  assert.isUndefined(terminalReplyState(data, "settled").reason);
});

it("retains a terminal code when unrelated reply fields are malformed", () => {
  const result = {
    isError: true,
    structuredContent: { code: "stopped_by_person", refusal: "bad", safety: null },
  };
  assert.equal(terminalReplyState(result).reason, "stopped_by_person");
  assert.isFalse(terminalReplyState(result).terminalSafety);
});

it.effect("the proxy sink merges nested Stop with an outer lock and keeps possible input", () =>
  Effect.gen(function* () {
    let output = "";
    const sink = terminalSink(
      {
        answer: (line) =>
          Effect.sync(() => {
            output = line;
          }),
      },
      { id: 1, method: "tools/call", params: { name: "click" } },
      () => "screen_locked",
      () => false,
    );
    yield* sink.answer(
      JSON.stringify({
        result: {
          isError: true,
          structuredContent: {
            code: "screen_locked",
            refusal: { code: "stopped_by_person" },
            safety: { retryClass: "never", possibleCommit: true },
          },
        },
      }),
    );
    assert.include(output, '"code":"stopped_by_person"');
    assert.include(output, '"possibleCommit":true');
    assert.notInclude(output, '"code":"screen_locked"');
  }),
);

it("the proxy fence never downgrades a person's stop to a lock", () => {
  const first = makePersonStopFence();
  first.confirm({ state: "paused", controlId: "control", reason: "screen_locked" });
  first.confirm({ state: "ended", reason: "stopped" });
  assert.equal(first.terminal(), "stopped_by_person");
  const second = makePersonStopFence();
  second.confirm({ state: "ended", reason: "stopped" });
  second.confirm({ state: "paused", controlId: "control", reason: "screen_locked" });
  assert.equal(second.terminal(), "stopped_by_person");
});

it.each(["lock then resume then stop", "lock then stop", "stop then lock"])(
  "an unfinished captured proxy epoch follows %s",
  (order) => {
    const fence = makePersonStopFence();
    const previous = fence.capture();
    if (order !== "stop then lock")
      fence.confirm({ state: "paused", controlId: "control", reason: "screen_locked" });
    if (order === "lock then resume then stop")
      fence.activate(
        { state: "active", controlId: "control", expiresAt: "2030-01-01T00:00:00Z" },
        "screen_locked",
        0,
      );
    fence.confirm({ state: "ended", reason: "stopped" });
    if (order === "stop then lock")
      fence.confirm({ state: "paused", controlId: "control", reason: "screen_locked" });
    assert.equal(previous(), "stopped_by_person");
  },
);

it.effect("an answered call releases its epoch and another control remains independent", () =>
  Effect.gen(function* () {
    const first = makePersonStopFence();
    const second = makePersonStopFence();
    const captured = first.capture();
    first.confirm({ state: "paused", controlId: "first", reason: "screen_locked" });
    const sink = terminalSink(
      { answer: () => Effect.void },
      { id: 1, method: "tools/call" },
      captured,
      () => false,
    );
    yield* sink.answer("{}");
    first.activate(
      { state: "active", controlId: "first", expiresAt: "2030-01-01T00:00:00Z" },
      "screen_locked",
      0,
    );
    first.confirm({ state: "ended", reason: "stopped" });
    assert.equal(captured(), "screen_locked");
    assert.isUndefined(second.terminal());
  }),
);
