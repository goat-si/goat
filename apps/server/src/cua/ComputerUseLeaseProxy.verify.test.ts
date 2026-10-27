// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { active, call, CONTROL, harness } from "./ComputerUseLeaseProxy.testkit.ts";

const window = { pid: 4, window_id: 9 };
const result = (id: unknown, structuredContent: object, text = "") =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: { content: text ? [{ type: "text", text }] : [], structuredContent },
  });
type Answer = {
  id: unknown;
  result: { content: Array<{ text?: string }>; structuredContent: Record<string, unknown> };
};

const readThenClick = Effect.fn(function* () {
  const h = yield* harness({ verifyInputByTreeDiff: true });
  yield* h.push(active());
  yield* h.send(call(1, "get_window_state", { ...window, query: "Dark", session: "s" }));
  yield* h.nextToDriver;
  yield* h.reply(result(1, { snapshot_id: "s1" }, "- [3] AXRadioButton (Dark)"));
  yield* h.nextToProvider;
  yield* h.send(call(2, "click", { ...window, element_token: "s1:3" }));
  yield* h.nextToDriver;
  yield* h.reply(result(2, { effect: "unverifiable" }, "Pressed."));
  return h;
});

describe("read-back after input the driver could not verify", () => {
  it.effect(
    "drops a read-back that answers after the lease stream dropped, keeping the input's own answer",
    () =>
      Effect.gen(function* () {
        let held = false;
        const h = yield* harness({ verifyInputByTreeDiff: true, transportHeld: () => held });
        yield* h.push(active());
        yield* h.send(call(1, "get_window_state", { ...window, query: "Dark", session: "s" }));
        yield* h.nextToDriver;
        yield* h.reply(result(1, { snapshot_id: "s1" }, "- [3] AXRadioButton (Dark)"));
        yield* h.nextToProvider;
        yield* h.send(call(2, "click", { ...window, element_token: "s1:3" }));
        yield* h.nextToDriver;
        yield* h.reply(result(2, { effect: "unverifiable" }, "Pressed."));
        const reread = yield* h.nextToDriver;
        held = true;
        yield* h.reply(
          result(
            reread.id,
            { since_status: "diff", snapshot_id: "s2" },
            "~ [3] secret window text",
          ),
        );
        const answer = (yield* h.nextToProvider) as unknown as Answer;
        assert.equal(answer.id, 2);
        assert.deepEqual(answer.result.structuredContent, { effect: "unverifiable" });
        assert.notInclude(JSON.stringify(answer), "secret window text");
      }),
  );

  it.effect(
    "an input reply while the lease stream reconnects waits for the cut-off, unread back",
    () =>
      Effect.gen(function* () {
        let held = false;
        const h = yield* harness({ verifyInputByTreeDiff: true, transportHeld: () => held });
        yield* h.push(active());
        yield* h.send(call(1, "get_window_state", window));
        yield* h.nextToDriver;
        yield* h.reply(result(1, { snapshot_id: "s1" }));
        yield* h.nextToProvider;
        yield* h.send(call(2, "click", { ...window, x: 3, y: 4 }));
        yield* h.nextToDriver;
        held = true;
        yield* h.reply(result(2, { effect: "unverifiable" }));
        yield* h.push({ state: "paused", controlId: CONTROL, reason: "human_input" });
        const answer = (yield* h.nextToProvider) as unknown as Answer;
        assert.equal(answer.id, 2);
        assert.include(JSON.stringify(answer), "may already have acted");
        // Only the pause's own cancellation may follow; the window is never read back.
        while ((yield* h.driverQueued) > 0)
          assert.notEqual(
            ((yield* h.nextToDriver) as { params?: { name?: unknown } }).params?.name,
            "get_window_state",
          );
      }),
  );

  it.effect(
    "confirms an input after which the window's tree changed, and names the new snapshot",
    () =>
      Effect.gen(function* () {
        const h = yield* readThenClick();
        const reread = yield* h.nextToDriver;
        assert.deepEqual((reread as { params: unknown }).params, {
          name: "get_window_state",
          arguments: {
            ...window,
            query: "Dark",
            session: "s",
            include_screenshot: false,
            since: "latest",
          },
        });
        yield* h.reply(
          result(
            reread.id,
            { since_status: "diff", snapshot_id: "s2" },
            "~ [3] AXRadioButton (Dark) selected",
          ),
        );
        const answer = (yield* h.nextToProvider) as unknown as Answer;
        assert.equal(answer.id, 2);
        assert.deepInclude(answer.result.structuredContent, {
          effect: "confirmed",
          verified_by: "goat_ax_diff",
          ax_changed: true,
          snapshot_id: "s2",
        });
        const added = answer.result.content.at(-1)?.text ?? "";
        assert.include(added, "s2:N");
        assert.include(added, "~ [3] AXRadioButton (Dark) selected");
      }),
  );

  it.effect("keeps an input unverifiable when the tree did not change", () =>
    Effect.gen(function* () {
      const h = yield* readThenClick();
      const reread = yield* h.nextToDriver;
      yield* h.reply(
        result(reread.id, { since_status: "no_change", snapshot_id: "s2" }, "no change"),
      );
      const answer = (yield* h.nextToProvider) as unknown as Answer;
      assert.deepInclude(answer.result.structuredContent, {
        effect: "unverifiable",
        ax_changed: false,
        snapshot_id: "s2",
      });
    }),
  );

  it.effect("passes input through unchanged without an earlier tree read of that window", () =>
    Effect.gen(function* () {
      const h = yield* harness({ verifyInputByTreeDiff: true });
      yield* h.push(active());
      yield* h.send(call(1, "click", { ...window, x: 3, y: 4 }));
      yield* h.nextToDriver;
      yield* h.reply(result(1, { effect: "unverifiable" }));
      const answer = (yield* h.nextToProvider) as unknown as Answer;
      assert.deepEqual(answer.result.structuredContent, { effect: "unverifiable" });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("leaves a confirmed input alone", () =>
    Effect.gen(function* () {
      const h = yield* harness({ verifyInputByTreeDiff: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", window));
      yield* h.nextToDriver;
      yield* h.reply(result(1, { snapshot_id: "s1" }));
      yield* h.nextToProvider;
      yield* h.send(call(2, "type_text", { ...window, text: "hi" }));
      yield* h.nextToDriver;
      yield* h.reply(result(2, { effect: "confirmed" }));
      const answer = (yield* h.nextToProvider) as unknown as Answer;
      assert.deepEqual(answer.result.structuredContent, { effect: "confirmed" });
      assert.equal(yield* h.driverQueued, 0);
    }),
  );

  it.effect("leaves a screen-run cell's input alone, so its tokens stay valid mid-script", () =>
    Effect.gen(function* () {
      const h = yield* harness({ verifyInputByTreeDiff: true });
      yield* h.push(active());
      const current = yield* h.driverStarted;
      yield* h.send(call(1, "get_window_state", window));
      yield* h.nextToDriver;
      yield* h.reply(result(1, { snapshot_id: "s1" }));
      yield* h.nextToProvider;
      yield* h.sendPrimitive({
        state: "primitive-request",
        requestId: "request:click",
        registrationId: "registration:one",
        controlId: CONTROL,
        connectionGeneration: current.connectionId,
        runId: "run:one",
        turnId: "cell:one",
        callId: 0,
        deadlineMillis: 1_000,
        tool: "click",
        args: { ...window, element_token: "s1:3" },
      });
      const sent = yield* h.nextToDriver;
      yield* h.reply(result(sent.id, { effect: "unverifiable" }));
      assert.include(JSON.stringify(yield* h.primitiveReply), "unverifiable");
      assert.equal(yield* h.driverQueued, 0);
    }),
  );
});
