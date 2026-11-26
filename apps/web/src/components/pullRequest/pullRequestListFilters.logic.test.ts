import { describe, expect, it } from "vite-plus/test";

import { selectedPullRequestLabels } from "./pullRequestList.logic";

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
});
