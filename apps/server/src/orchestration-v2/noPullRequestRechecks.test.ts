import { describe, expect, it } from "@effect/vitest";
import { makeNoPullRequestRechecks } from "./noPullRequestRechecks.ts";

describe("missing pull request rechecks", () => {
  it("increases the interval as a branch becomes idle", () => {
    const scheduler = makeNoPullRequestRechecks();
    const hour = 60 * 60 * 1_000;
    const now = 100 * hour;
    const branch = [{ key: "idle", activityAtMs: now - 48 * hour }];
    expect(scheduler.select(now, branch).has("idle")).toBe(true);
    scheduler.record("idle", now, false);
    expect(scheduler.select(now + 4 * hour, branch).has("idle")).toBe(false);
    expect(scheduler.select(now + 5 * hour, branch).has("idle")).toBe(true);
  });
});
