import { describe, expect, it } from "vite-plus/test";

import { rememberPullRequestLabels, selectedPullRequestLabels } from "./pullRequestList.logic";

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
});
