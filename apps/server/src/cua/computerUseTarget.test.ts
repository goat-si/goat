import { assert, describe, it } from "@effect/vitest";

import { targetOf } from "./computerUseTarget.ts";

describe("targetOf", () => {
  it("reads the window from the top level or from an exact window target", () => {
    assert.deepEqual(targetOf({ pid: 4, window_id: 9, x: 1 }), { pid: 4, windowId: 9 });
    assert.deepEqual(targetOf({ target: { kind: "window", pid: 4, window_id: 9 } }), {
      pid: 4,
      windowId: 9,
    });
  });

  it("names no window for a desktop or app target, a missing id, or arguments that are not ids", () => {
    for (const args of [
      { target: { kind: "desktop", display_id: "primary" } },
      { pid: 4 },
      { pid: 4, window_id: 9.5 },
      { pid: "4", window_id: 9 },
      [4, 9],
      undefined,
    ])
      assert.isUndefined(targetOf(args));
  });
});
