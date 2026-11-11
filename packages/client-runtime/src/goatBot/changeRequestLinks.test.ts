import { describe, expect, it } from "vite-plus/test";

import { goatBotChangeRequestLabel, goatBotReplyRepository } from "./changeRequestLinks.ts";

const pr = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

describe("pull request links in a bot reply", () => {
  it("names the reply's repository only when every pull request link is in it", () => {
    expect(
      goatBotReplyRepository([pr("goat-si/goat", 2851), pr("goat-si/goat", 2850)])?.repository,
    ).toBe("goat-si/goat");
    expect(goatBotReplyRepository([pr("goat-si/goat", 1), pr("other/repo", 2)])).toBeNull();
    expect(goatBotReplyRepository([])).toBeNull();
  });

  it("links a bare #number only to the reply's one repository", () => {
    const repo = goatBotReplyRepository([pr("goat-si/goat", 2851)]);
    const links = repo?.references("#2816 follows #2806, see abc1234 and @someone") ?? [];
    expect(links.map((link) => [link.label, link.url])).toEqual([
      ["#2816", "https://github.com/goat-si/goat/issues/2816"],
      ["#2806", "https://github.com/goat-si/goat/issues/2806"],
    ]);
  });

  it("labels a pull request #N in the reply's repository and owner/repo#N elsewhere", () => {
    const repo = goatBotReplyRepository([pr("goat-si/goat", 2851)]);
    expect(goatBotChangeRequestLabel(pr("goat-si/goat", 2851), repo)).toBe("#2851");
    expect(goatBotChangeRequestLabel(pr("other/repo", 7), repo)).toBe("other/repo#7");
    expect(goatBotChangeRequestLabel("https://vite.dev/guide/", repo)).toBeNull();
  });

  it("never shortens a look-alike host, so the label cannot hide where a link goes", () => {
    const lookAlike = "https://github.com.evil.example/a/b/pull/7";
    expect(goatBotChangeRequestLabel(lookAlike, null)).toBeNull();
    expect(goatBotReplyRepository([lookAlike])).toBeNull();
    // A look-alike beside a real link does not lend the reply a repository either.
    expect(goatBotReplyRepository([lookAlike, pr("goat-si/goat", 1)])?.repository).toBe(
      "goat-si/goat",
    );
  });

  it("labels a GitLab merge request with !", () => {
    const mr = "https://gitlab.com/group/project/-/merge_requests/12";
    expect(goatBotChangeRequestLabel(mr, null)).toBe("group/project!12");
    expect(goatBotChangeRequestLabel(mr, goatBotReplyRepository([mr]))).toBe("!12");
  });
});
