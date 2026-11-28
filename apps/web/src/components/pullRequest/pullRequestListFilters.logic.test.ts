import { ProjectId, SourceControlProviderKind, type PullRequestListEntry } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchesPullRequestFilters,
  rememberPullRequestAuthors,
  rememberPullRequestLabels,
  selectedPullRequestAuthor,
  selectedPullRequestLabels,
} from "./pullRequestList.logic";

const actor = (login: string, name: string | null = null) => ({ login, name, avatarUrl: null });

describe("filter picker choices", () => {
  it("restores a selected label's color and count from loaded facets or host labels", () => {
    const loaded = [{ name: "bug", color: "d73a4a", count: 5 }];
    const hosted = [{ name: "size:XL", color: "d93f0b" }];

    expect(selectedPullRequestLabels(loaded, hosted, ["BUG", "size:xl", "custom"])).toEqual([
      { name: "bug", color: "d73a4a", count: 5 },
      { name: "size:XL", color: "d93f0b", count: 0 },
      { name: "custom", color: null, count: 0 },
    ]);
  });

  it("keeps a host-only label's color after the host answers a new search without it", () => {
    const first = rememberPullRequestLabels([], [{ name: "release-blocker", color: "b60205" }]);
    const next = rememberPullRequestLabels(first, [{ name: "docs", color: "0075ca" }]);

    expect(selectedPullRequestLabels([], next, ["release-blocker"])).toEqual([
      { name: "release-blocker", color: "b60205", count: 0 },
    ]);
    expect(rememberPullRequestLabels(next, [{ name: "docs", color: "0075ca" }])).toBe(next);
  });

  it("keeps a host-only author's avatar after the host answers a new search without them", () => {
    const juliana = { login: "Juliana", name: "Juliana", avatarUrl: "https://host/juliana.png" };
    const first = rememberPullRequestAuthors([], [juliana]);
    const next = rememberPullRequestAuthors(first, [actor("sam")]);

    expect(selectedPullRequestAuthor([], next, "juliana")?.actor).toEqual(juliana);
    expect(rememberPullRequestAuthors(next, [actor("sam")])).toBe(next);
    expect(rememberPullRequestAuthors(next, [])).toBe(next);

    const moved = { ...juliana, avatarUrl: "https://host/juliana-new.png" };
    expect(
      selectedPullRequestAuthor([], rememberPullRequestAuthors(first, [moved]), "juliana")?.actor,
    ).toEqual(moved);
  });
});

function entry(
  overrides: Partial<PullRequestListEntry> & { number: number },
): PullRequestListEntry {
  return {
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    repository: "owner/repo",
    title: `PR #${overrides.number}`,
    url: `https://github.com/owner/repo/pull/${overrides.number}`,
    author: { login: "author", name: null, avatarUrl: null },
    state: "open",
    isDraft: false,
    headBranch: `feat/${overrides.number}`,
    baseBranch: "main",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    mergeability: "unknown",
    additions: 1,
    deletions: 0,
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  };
}

describe("matchesPullRequestFilters", () => {
  it.each([
    ["passing", [1, 4]],
    ["failing", [2, 4]],
  ] as const)("narrows rows by checks:%s and keeps unknown check state", (checks, kept) => {
    const rows = [
      entry({ number: 1, checksState: "passing" }),
      entry({ number: 2, checksState: "failing" }),
      entry({ number: 3, checksState: "pending" }),
      entry({ number: 4 }),
    ];
    expect(
      rows.filter((row) => matchesPullRequestFilters(row, { checks })).map((row) => row.number),
    ).toEqual(kept);
  });
});
