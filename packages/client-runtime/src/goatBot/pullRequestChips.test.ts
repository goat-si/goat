import { describe, expect, it } from "vite-plus/test";

import { goatBotRowPullRequests } from "./pullRequestChips.ts";

const pullRequests = [
  { repository: "goat-si/goat", number: 42, state: "open", watching: true },
  { repository: "goat-si/goat", number: 40, watching: false },
  { repository: "goat-si/goat", number: 39, state: "merged", watching: false },
] as const;

describe("goatBotRowPullRequests", () => {
  it("names each pull request's state in words, shows the repository only across repositories, and counts what it hides", () => {
    expect(goatBotRowPullRequests({}, 2)).toEqual({ chips: [], more: 0, moreLabel: null });

    const oneRepository = goatBotRowPullRequests({ pullRequests, pullRequestsOmitted: 2 }, 1);
    expect(oneRepository.chips).toEqual([
      {
        key: "goat-si/goat#42",
        number: 42,
        state: "open",
        text: "#42",
        stateLabel: "Open",
        accessibleName: "Pull request goat-si/goat#42, open",
      },
    ]);
    expect(oneRepository.more).toBe(4);
    expect(oneRepository.moreLabel).toBe("+4 more");

    const all = goatBotRowPullRequests({ pullRequests }, 3);
    expect(all.chips.map((chip) => [chip.text, chip.stateLabel, chip.accessibleName])).toEqual([
      ["#42", "Open", "Pull request goat-si/goat#42, open"],
      ["#40", "State unknown", "Pull request goat-si/goat#40, state unknown"],
      ["#39", "Merged", "Pull request goat-si/goat#39, merged"],
    ]);
    expect(all.moreLabel).toBeNull();

    const spanning = goatBotRowPullRequests(
      {
        pullRequests: [
          ...pullRequests.slice(0, 1),
          { repository: "goat-si/docs", number: 7, state: "closed", watching: false },
        ],
      },
      2,
    );
    expect(spanning.chips.map((chip) => [chip.text, chip.state, chip.accessibleName])).toEqual([
      ["goat#42", "open", "Pull request goat-si/goat#42, open"],
      ["docs#7", "closed", "Pull request goat-si/docs#7, closed"],
    ]);
    expect(spanning.more).toBe(0);
  });
});
