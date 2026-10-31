import { assert, it } from "@effect/vitest";
import { mergeTerminal } from "./ComputerUseTerminal.ts";

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
