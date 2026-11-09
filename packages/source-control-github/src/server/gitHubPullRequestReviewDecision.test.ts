import { listJson, listPage, through, user } from "./gitHubPullRequestJsonTestFixtures.ts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { LenientPullRequestList, toPullRequestRows } from "./gitHubPullRequestJson.ts";

const decode = through(LenientPullRequestList.result, (result) =>
  listPage(toPullRequestRows(result.repository?.pullRequests)),
);

describe("pull request review decisions", () => {
  it("keeps review required when an approval falls short of the branch's required count", () => {
    const decoded = decode(
      listJson([
        {
          reviewDecision: "REVIEW_REQUIRED",
          latestReviews: [{ author: user("octocat"), state: "APPROVED" }],
        },
      ]),
    );
    if (Result.isFailure(decoded)) throw new Error(`expected a successful decode`);
    expect(decoded.success.items.map((entry) => entry.reviewDecision)).toEqual(["review-required"]);
  });
});
