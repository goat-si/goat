import { describe, expect, it } from "vite-plus/test";

import { goatBotChangeRequestLabel, goatBotReplyRepository } from "./changeRequestLinks.ts";

const pr = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

describe("pull request links in a bot reply", () => {
  it("names the reply's repository only when every pull request link is in it", () => {
    expect(
      goatBotReplyRepository(`Merged ${pr("goat-si/goat", 2851)} and ${pr("goat-si/goat", 2850)}.`)
        ?.repository,
    ).toBe("goat-si/goat");
    expect(
      goatBotReplyRepository(`${pr("goat-si/goat", 1)} and ${pr("other/repo", 2)}`),
    ).toBeNull();
    expect(goatBotReplyRepository("No links, just #2816.")).toBeNull();
  });

  it("links a bare #number only to the reply's one repository", () => {
    const repo = goatBotReplyRepository(`See ${pr("goat-si/goat", 2851)}.`);
    const links = repo?.references("#2816 follows #2806, see abc1234 and @someone") ?? [];
    expect(links.map((link) => [link.label, link.url])).toEqual([
      ["#2816", "https://github.com/goat-si/goat/issues/2816"],
      ["#2806", "https://github.com/goat-si/goat/issues/2806"],
    ]);
  });

  it("labels a pull request #N in the reply's repository and owner/repo#N elsewhere", () => {
    const repo = goatBotReplyRepository(pr("goat-si/goat", 2851));
    expect(goatBotChangeRequestLabel(pr("goat-si/goat", 2851), repo)).toBe("#2851");
    expect(goatBotChangeRequestLabel(pr("other/repo", 7), repo)).toBe("other/repo#7");
    expect(goatBotChangeRequestLabel("https://vite.dev/guide/", repo)).toBeNull();
  });
});
