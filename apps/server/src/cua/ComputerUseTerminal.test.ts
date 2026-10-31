import { assert, it } from "@effect/vitest";
import { mergeTerminal } from "./ComputerUseTerminal.ts";
import { makePersonStopFence } from "./ComputerUseLeaseProxyPersonStop.ts";

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
