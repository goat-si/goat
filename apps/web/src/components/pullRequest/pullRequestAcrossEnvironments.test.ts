import type { EnvironmentId, PullRequestListResult } from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import {
  mergePullRequestLists,
  partitionPullRequestsWithPriority,
  type EnvironmentPullRequestEntry,
} from "./pullRequestList.logic";

const row = (environmentId: string, host = "github.com") =>
  ({
    environmentId,
    host,
    repository: "goat-si/goat",
    number: 31,
    url: `https://${host}/goat-si/goat/pull/31`,
    updatedAt: "2026-07-02T00:00:00Z",
  }) as EnvironmentPullRequestEntry;

it("recognizes the same priority pull request from another environment", () => {
  const priority = row("env-1");
  const feed = row("env-2");
  const groups = partitionPullRequestsWithPriority([feed], [priority], [feed]);
  expect(groups.map((group) => group.key)).toEqual(["authored"]);
  expect(groups[0]!.entries).toEqual([feed]);
});

it("deduplicates a pull request across environments without merging different hosts", () => {
  const answer = (entries: EnvironmentPullRequestEntry[]) =>
    ({
      viewers: {},
      providers: [],
      entries,
      errors: [],
      truncated: false,
      nextCursors: {},
    }) as PullRequestListResult;
  const merged = mergePullRequestLists([
    ["env-1" as EnvironmentId, answer([row("env-1")])],
    ["env-2" as EnvironmentId, answer([row("env-2"), row("env-2", "git.example.test")])],
  ]);
  expect(merged?.entries.map((entry) => [entry.environmentId, entry.host])).toEqual([
    ["env-1", "github.com"],
    ["env-2", "git.example.test"],
  ]);
});
