import { expect, it } from "vite-plus/test";
import { sourceControlClients } from "./sourceControlClients.ts";
import { parsePullRequestAnchor, pullRequestLinkCommit } from "@goat/shared/pullRequestAnchor";

it("routes Forgejo links with authority and retains their original navigation intent", () => {
  const sha = "a".repeat(40);
  const url = `https://forgejo.example:8443/team/repo/pulls/7/commits/${sha}#diff-abcR5`;
  const target = sourceControlClients.parseChangeRequestUrl(url);
  expect(target?.definition.kind).toBe("forgejo");
  expect(target?.link).toMatchObject({
    repository: "team/repo",
    number: 7,
    authority: "forgejo.example:8443",
  });
  expect(pullRequestLinkCommit(url)).toBe(sha);
  expect(parsePullRequestAnchor(url)).toMatchObject({ kind: "diff", digest: "abc" });
});
