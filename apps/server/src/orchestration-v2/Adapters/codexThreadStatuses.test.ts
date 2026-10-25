import { assert, describe, it } from "@effect/vitest";

import { makeCodexThreadStatuses } from "./codexThreadStatuses.ts";

// Codex can publish a goal update it queued before a pause after the pause itself (#1564).
describe("Codex goal ordering for the computer use reload", () => {
  it("keeps a paused or cleared goal inactive when an older active update arrives late", () => {
    const statuses = makeCodexThreadStatuses();
    statuses.goal("root", "active", 100);
    statuses.goal("root", "paused", 100);
    statuses.goal("root", "active", 100);
    assert.isFalse(statuses.goalActive(["root"]));
    statuses.goal("root", "active", 99);
    assert.isFalse(statuses.goalActive(["root"]));
    statuses.goal("root", "active", 101);
    assert.isTrue(statuses.goalActive(["root"]));
    statuses.goal("root", null);
    statuses.goal("root", "active", 101);
    assert.isFalse(statuses.goalActive(["root"]));
  });

  it("counts an active goal on any thread of the conversation", () => {
    const statuses = makeCodexThreadStatuses();
    statuses.goal("child", "active", 100);
    assert.isTrue(statuses.goalActive(["root", "child"]));
    assert.isFalse(statuses.goalActive(["root"]));
  });
});
