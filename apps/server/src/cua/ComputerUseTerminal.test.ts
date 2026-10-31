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
