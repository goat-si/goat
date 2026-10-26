import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { active, call, harness } from "./ComputerUseLeaseProxy.testkit.ts";

it.effect("retries a timed-out capture hide and forwards a later capture after its ack", () =>
  Effect.gen(function* () {
    let visible = false;
    let hideCount = 0;
    const overlay = Object.assign(
      (command: { readonly op: "show" | "hide" }) =>
        Effect.sync(() => {
          if (command.op === "show") visible = true;
          if (command.op === "hide" && ++hideCount >= 3) visible = false;
        }),
      { captureHideConfirmed: () => !visible },
    );
    const h = yield* harness({ overlay });
    yield* h.push(active());
    const window = { pid: 4, window_id: 9 };
    yield* h.send(call(1, "click", window));
    assert.equal((yield* h.nextToDriver).id, 1);
    yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
    yield* h.nextToProvider;
    yield* h.send(call(2, "get_window_state", window));
    assert.include(JSON.stringify(yield* h.nextToProvider), '"detail":"capture_hide_unconfirmed"');
    yield* h.send(call(3, "get_window_state", window));
    assert.equal((yield* h.nextToDriver).id, 3);
    assert.equal(hideCount, 3);
  }),
);
