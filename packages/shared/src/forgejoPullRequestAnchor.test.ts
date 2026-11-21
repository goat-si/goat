import { expect, it } from "vite-plus/test";
import { parsePullRequestAnchor, pullRequestLinkCommit } from "./pullRequestAnchor.ts";

it("retains Forgejo tab, commit and line intent", () => {
  const root = "https://forgejo.example:8443/org/repo/pulls/7";
  const sha = "a".repeat(40);
  expect(parsePullRequestAnchor(`${root}/files`)).toEqual({ kind: "code" });
  expect(parsePullRequestAnchor(`${root}/commits`)).toEqual({ kind: "commits" });
  expect(pullRequestLinkCommit(`${root}/commits/${sha}#diff-abcR5`)).toBe(sha);
  expect(parsePullRequestAnchor(`${root}/commits/${sha}#diff-abcR5`)).toMatchObject({
    kind: "diff",
    digest: "abc",
    range: { start: 5, side: "right" },
  });
});
