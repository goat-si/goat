import { describe, expect, it } from "vitest";
import type { ThreadPullRequestSnapshot } from "@goat/contracts";
import { isFinalPullRequestSnapshot } from "./pullRequestSyncFinal.ts";

const snapshot = (state: "open" | "closed" | "merged", time: string | null) =>
  ({ state, closedAt: time, mergedAt: time }) as ThreadPullRequestSnapshot;

describe("pull request sync finality", () => {
  it("keeps recent or undated closed and undated merged requests eligible for refresh", () => {
    const now = Date.parse("2026-08-28T12:00:00Z");
    expect(isFinalPullRequestSnapshot(snapshot("closed", "2026-08-27T12:00:00Z"), now)).toBe(true);
    expect(isFinalPullRequestSnapshot(snapshot("closed", "2026-08-27T12:00:01Z"), now)).toBe(false);
    expect(isFinalPullRequestSnapshot(snapshot("closed", null), now)).toBe(false);
    expect(isFinalPullRequestSnapshot(snapshot("merged", null), now)).toBe(false);
    expect(isFinalPullRequestSnapshot(snapshot("merged", "2026-08-28T12:00:00Z"), now)).toBe(true);
    expect(isFinalPullRequestSnapshot(snapshot("open", null), now)).toBe(false);
  });
});
