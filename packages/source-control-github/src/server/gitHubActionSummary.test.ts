import { expect, it } from "vite-plus/test";
import { toPullRequestActionSummary } from "./gitHubActionSummary.ts";

it("maps a merge reply and its merge time into a pull request summary", () => {
  expect(
    toPullRequestActionSummary({
      number: 7,
      title: "Change",
      url: "https://github.com/acme/web/pull/7",
      headRefName: "topic",
      baseRefName: "main",
      state: "MERGED",
      isDraft: false,
      updatedAt: "2026-10-27T12:00:00Z",
      mergedAt: "2026-10-27T11:59:00Z",
      closedAt: "2026-10-27T11:59:00Z",
      headRefOid: "abc123",
      author: null,
      autoMergeRequest: null,
    }),
  ).toMatchObject({
    number: 7,
    state: "merged",
    headSha: "abc123",
    autoMergeEnabled: false,
    mergedAt: "2026-10-27T11:59:00Z",
  });
  expect(toPullRequestActionSummary(null)).toBeUndefined();
});
