import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { mergeTerminal, terminalFailure, terminalReplyState } from "./ComputerUseTerminal.ts";
import {
  finalTerminalLine,
  makePersonStopFence,
  terminalSink,
} from "./ComputerUseLeaseProxyPersonStop.ts";

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
  const marked = { structuredContent: { code: "screen_locked", safety: { possibleCommit: true } } };
  const state = terminalReplyState(marked, "settled");
  assert.isUndefined(state.reason);
  assert.isTrue(state.possibleCommit);
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

it.effect("the proxy sink merges a terminal RPC error with the result", () =>
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
        error: {
          code: -32000,
          data: { code: "stopped_by_person", safety: { possibleCommit: true } },
        },
        result: {
          isError: true,
          structuredContent: {
            code: "screen_locked",
            safety: { retryClass: "never", possibleCommit: false },
          },
        },
      }),
    );
    assert.include(output, '"code":"stopped_by_person"');
    assert.include(output, '"possibleCommit":true');
  }),
);

it.effect.each(["result lock then Stop", "RPC Stop under lock"])(
  "retains explicit possible input on a read: %s",
  (order) =>
    Effect.gen(function* () {
      let output = "";
      const sink = terminalSink(
        {
          answer: (line) =>
            Effect.sync(() => {
              output = line;
            }),
        },
        { id: 1, method: "tools/call", params: { name: "list_apps" } },
        () => (order === "result lock then Stop" ? "stopped_by_person" : "screen_locked"),
        () => false,
      );
      const value =
        order === "result lock then Stop"
          ? {
              result: {
                isError: true,
                structuredContent: {
                  code: "screen_locked",
                  safety: { retryClass: "never", possibleCommit: true },
                },
              },
            }
          : {
              error: {
                code: -32000,
                data: { code: "stopped_by_person", safety: { possibleCommit: true } },
              },
            };
      yield* sink.answer(JSON.stringify(value), "unknown_outcome");
      assert.include(output, '"code":"stopped_by_person"');
      assert.include(output, '"retryClass":"never"');
      assert.include(output, '"possibleCommit":true');
    }),
);

it.effect("applies a late terminal latch after an outbound transformation", () =>
  Effect.gen(function* () {
    let terminal: "stopped_by_person" | undefined;
    let written = "";
    const sink = terminalSink(
      {
        answer: (_line, status, context) =>
          Effect.sync(() => {
            terminal = "stopped_by_person";
            const shaped = JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { isError: true, structuredContent: { code: "unavailable" } },
            });
            written = finalTerminalLine(
              shaped,
              status,
              context?.request,
              context?.terminalState?.() ?? { possibleCommit: false },
            ).line;
          }),
      },
      { id: 1, method: "tools/call", params: { name: "list_apps" } },
      () => terminal,
      () => false,
    );
    yield* sink.answer(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    assert.include(written, '"code":"stopped_by_person"');
    assert.include(written, '"retryClass":"never"');
  }),
);

it.effect("a dispatched read without input is not marked as possibly committed", () =>
  Effect.gen(function* () {
    let written = "";
    const sink = terminalSink(
      {
        answer: (line) =>
          Effect.sync(() => {
            written = line;
          }),
      },
      { id: 1, method: "tools/call", params: { name: "list_apps" } },
      () => "screen_locked",
      () => true,
    );
    yield* sink.answer(
      JSON.stringify({
        result: {
          isError: true,
          structuredContent: {
            code: "screen_locked",
            safety: { retryClass: "never", possibleCommit: false },
          },
        },
      }),
      "settled",
    );
    assert.include(written, '"possibleCommit":false');
  }),
);

it.each(["screen_locked", "stopped_by_person"] as const)(
  "terminal failure keeps possible input for a read: %s",
  (reason) => {
    const failure = terminalFailure({ reason, possibleCommit: true }, "list_apps", {}, false);
    assert.equal(failure?.code, reason);
    assert.isTrue(failure?.safety?.possibleCommit);
    assert.equal(failure?.safety?.retryClass, "never");
  },
);

it("preserves possible input when an unrelated retry field is malformed", () => {
  const reply = {
    isError: true,
    structuredContent: { code: "screen_locked", safety: { possibleCommit: true, retryClass: 123 } },
  };
  const state = terminalReplyState(reply, "settled");
  assert.equal(state.reason, "screen_locked");
  assert.isTrue(state.possibleCommit);
  assert.isFalse(state.terminalSafety);
});

it("preserves terminal evidence when a failed reply has a malformed error marker", () => {
  const reply = {
    isError: "bad",
    structuredContent: { code: "screen_locked", safety: { possibleCommit: true } },
  };
  const state = terminalReplyState(reply, "unknown_outcome");
  assert.equal(state.reason, "screen_locked");
  assert.isTrue(state.possibleCommit);
});
