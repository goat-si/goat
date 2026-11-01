import { assert, describe, it } from "@effect/vitest";

import { movesPersonPointer } from "./ComputerUsePointerPolicy.ts";

const call = (name: string, args: Record<string, unknown> = {}) => ({ name, args });

describe("which calls move the person's pointer", () => {
  it("counts foreground pointer delivery and desktop pointer moves, nothing else", () => {
    for (const name of ["click", "double_click", "right_click", "drag", "scroll", "move_cursor"])
      assert.isTrue(
        movesPersonPointer(call(name, { pid: 1, window_id: 2, delivery_mode: "foreground" })),
        name,
      );
    assert.isTrue(movesPersonPointer(call("move_cursor", { scope: "desktop", x: 1, y: 1 })));
    // A foreground step inside a batch moves the pointer the same way.
    assert.isTrue(
      movesPersonPointer(
        call("run_steps", {
          steps: [{ tool: "click", args: { pid: 1, window_id: 2, delivery_mode: "foreground" } }],
        }),
      ),
    );
    // Background (virtual cursor) clicks, element tokens and keyboard never move it.
    assert.isFalse(movesPersonPointer(call("click", { pid: 1, window_id: 2, x: 5, y: 5 })));
    assert.isFalse(movesPersonPointer(call("click", { pid: 1, window_id: 2, element_token: "t" })));
    assert.isFalse(movesPersonPointer(call("move_cursor", { pid: 1, window_id: 2, x: 1, y: 1 })));
    assert.isFalse(
      movesPersonPointer(call("type_text", { pid: 1, text: "a", delivery_mode: "foreground" })),
    );
    assert.isFalse(
      movesPersonPointer(call("press_key", { pid: 1, key: "a", delivery_mode: "foreground" })),
    );
    assert.isFalse(
      movesPersonPointer(
        call("run_steps", { steps: [{ tool: "click", args: { pid: 1, window_id: 2 } }] }),
      ),
    );
  });
});
