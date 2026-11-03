import type { PullRequestListEntry } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { comparePullRequestsByRecency } from "./pullRequestRecency";

it("orders instants across offsets and places invalid timestamps last (#23588)", () => {
  const entries = [
    "invalid",
    "2026-07-05T01:00:00+02:00",
    "2026-07-05T00:30:00Z",
    "2026-07-05T00:30:00.5Z",
  ].map((updatedAt) => ({ updatedAt }) as PullRequestListEntry);
  expect(entries.toSorted(comparePullRequestsByRecency).map((entry) => entry.updatedAt)).toEqual([
    "2026-07-05T00:30:00.5Z",
    "2026-07-05T00:30:00Z",
    "2026-07-05T01:00:00+02:00",
    "invalid",
  ]);
});
