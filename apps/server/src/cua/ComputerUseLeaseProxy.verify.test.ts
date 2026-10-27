// @effect-diagnostics preferSchemaOverJson:off -- The fixture speaks MCP JSON-RPC lines.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  active,
  call,
  CONTROL,
  harness,
  unknownWriteSafety,
} from "./ComputerUseLeaseProxy.testkit.ts";

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

const settingsTree = [
  '- [0] AXWindow "Settings"',
  '  - [1] AXGroup "Appearance"',
  "    - [2] AXRadioButton (Light)",
  "    - [3] AXRadioButton (Dark)",
  '  - [4] AXStaticText "12:00"',
].join("\n");

const clickDarkThenDiff = Effect.fn(function* (since: object, diffText: string) {
  const h = yield* harness({ verifyInputByTreeDiff: true });
  yield* h.push(active());
  yield* h.send(call(1, "get_window_state", { ...window, session: "s" }));
  yield* h.nextToDriver;
  yield* h.reply(result(1, { snapshot_id: "s1" }, settingsTree));
  yield* h.nextToProvider;
  yield* h.send(call(2, "click", { ...window, element_token: "s1:3" }));
  yield* h.nextToDriver;
  yield* h.reply(result(2, { effect: "unverifiable" }, "Pressed."));
  const reread = yield* h.nextToDriver;
  yield* h.reply(result(reread.id, since, diffText));
  return ((yield* h.nextToProvider) as unknown as Answer).result;
});

describe("read-back stays inside the call's own control boundaries", () => {
  it.effect("a click by element token alone is read back on the window that token came from", () =>
    Effect.gen(function* () {
      const h = yield* harness({ verifyInputByTreeDiff: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { ...window, session: "s" }));
      yield* h.nextToDriver;
      yield* h.reply(result(1, { snapshot_id: "s1" }, settingsTree));
      yield* h.nextToProvider;
      yield* h.send(call(2, "click", { element_token: "s1:3", session: "s" }));
      yield* h.nextToDriver;
      yield* h.reply(result(2, { effect: "unverifiable" }, "Pressed."));
      const reread = (yield* h.nextToDriver) as { params: { name: string; arguments: object } };
      assert.equal(reread.params.name, "get_window_state");
      assert.deepInclude(reread.params.arguments, { ...window, since: "latest" });
    }),
  );

  it.effect("a private pause during the read-back answers the click as cut off", () =>
    Effect.gen(function* () {
      const h = yield* readThenClick();
      yield* h.nextToDriver;
      yield* h.push({ state: "paused", controlId: CONTROL, reason: "private" });
      const answer = (yield* h.nextToProvider) as unknown as Answer;
      assert.equal(answer.id, 2);
      assert.deepInclude(answer.result.structuredContent, { code: "interrupted" });
    }),
  );
});

describe("read-back confirms only a change around the element the input aimed at", () => {
  it.effect("a clock that ticked elsewhere in the window is no confirmation", () =>
    Effect.gen(function* () {
      const answer = yield* clickDarkThenDiff(
        { since_status: "diff", snapshot_id: "s2" },
        '~ [4] AXStaticText "12:01"',
      );
      assert.equal(answer.structuredContent.effect, "unverifiable");
      assert.include(answer.content.at(-1)?.text ?? "", '~ [4] AXStaticText "12:01"');
      assert.isTrue(
        (answer.structuredContent.safety as { possibleCommit: boolean }).possibleCommit,
      );
    }),
  );

  it.effect("most of the tree changing says nothing about the target", () =>
    Effect.gen(function* () {
      const answer = yield* clickDarkThenDiff(
        { since_status: "too_much_changed", snapshot_id: "s2" },
        "full read",
      );
      assert.equal(answer.structuredContent.effect, "unverifiable");
    }),
  );

  it.effect("rows inserted before the target shift numbers into its range without confirming", () =>
    Effect.gen(function* () {
      const answer = yield* clickDarkThenDiff(
        { since_status: "diff", snapshot_id: "s2" },
        ['+ [1] AXToolbar "Tools"', '+ [2] AXButton "Back"', "reindexed: [1-4] -> [3-6]"].join(
          "\n",
        ),
      );
      assert.equal(answer.structuredContent.effect, "unverifiable");
      assert.isTrue(
        (answer.structuredContent.safety as { possibleCommit: boolean }).possibleCommit,
      );
    }),
  );

  it.effect("a change in another unnumbered toolbar does not confirm a click in the first", () =>
    Effect.gen(function* () {
      const h = yield* harness({ verifyInputByTreeDiff: true });
      yield* h.push(active());
      yield* h.send(call(1, "get_window_state", { ...window, session: "s" }));
      yield* h.nextToDriver;
      yield* h.reply(
        result(
          1,
          { snapshot_id: "s1" },
          [
            '- AXWindow "Editor"',
            "  - AXToolbar",
            '    - [0] AXButton "Apply"',
            "  - AXToolbar",
            '    - [1] AXStaticText "12:00"',
          ].join("\n"),
        ),
      );
      yield* h.nextToProvider;
      yield* h.send(call(2, "click", { ...window, element_token: "s1:0" }));
      yield* h.nextToDriver;
      yield* h.reply(result(2, { effect: "unverifiable" }, "Pressed."));
      const reread = yield* h.nextToDriver;
      yield* h.reply(
        result(
          reread.id,
          { since_status: "diff", snapshot_id: "s2" },
          '~ [1] AXStaticText "12:01"',
        ),
      );
      const answer = ((yield* h.nextToProvider) as unknown as Answer).result;
      assert.equal(answer.structuredContent.effect, "unverifiable");
    }),
  );

  it.effect("a sibling the click switched off confirms it", () =>
    Effect.gen(function* () {
      const answer = yield* clickDarkThenDiff(
        { since_status: "diff", snapshot_id: "s2" },
        "~ [2] AXRadioButton (Light) unselected",
      );
      assert.equal(answer.structuredContent.effect, "confirmed");
    }),
  );
});

describe("read-back after input the driver could not verify", () => {
  it.effect(
    "a lease stream that drops during the read-back cuts the input off as possibly applied, unread back",
    () =>
      Effect.gen(function* () {
        let held = false;
        let drop: (() => void) | undefined;
        const h = yield* harness({
          verifyInputByTreeDiff: true,
          transportHeld: () => held,
          onTransportDropReceiver: (receive) => {
            drop = receive;
          },
        });
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
        drop?.();
        const answer = (yield* h.nextToProvider) as unknown as Answer;
        yield* h.reply(
          result(
            reread.id,
            { since_status: "diff", snapshot_id: "s2" },
            "~ [3] secret window text",
          ),
        );
        assert.equal(answer.id, 2);
        assert.include(JSON.stringify(answer), "may already have acted");
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
        // The read-back confirmed it, so the input committed.
        assert.deepInclude(answer.result.structuredContent.safety as object, {
          possibleCommit: true,
          writeStatus: "committed",
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
      assert.deepInclude(answer.result.structuredContent.safety as object, {
        possibleCommit: true,
        writeStatus: "may_have_applied",
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
      assert.deepEqual(answer.result.structuredContent, {
        effect: "unverifiable",
        safety: unknownWriteSafety,
      });
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
      assert.deepEqual(answer.result.structuredContent, {
        effect: "confirmed",
        safety: {
          possibleCommit: true,
          retryClass: "never",
          writeStatus: "committed",
          code: "write_committed",
        },
      });
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
