import { afterEach, assert, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  layer,
  route,
  SUBJECT_SCOPE_QUERY,
  variablesOf,
  mockedExecute,
  mockedStackMemberships,
  mockedCredential,
  defaultCredential,
} from "./GitHubPullRequestApi.testkit.ts";
afterEach(() => {
  mockedExecute.mockReset();
  mockedStackMemberships.mockReset();
  mockedCredential.mockReset();
  mockedCredential.mockImplementation(defaultCredential);
});
layer("review thread scope", (it) => {
  // regression: #41735 a thread id from another pull request is refused before any write
  it.effect.each([
    { mutation: "AddReviewThreadReply", body: "hello" },
    { mutation: "ResolveReviewThread", resolved: true },
    { mutation: "UnresolveReviewThread", resolved: false },
  ])("refuses $mutation on a review thread from another pull request", (write) =>
    Effect.gen(function* () {
      route([
        SUBJECT_SCOPE_QUERY,
        {
          data: {
            repository: { pullRequest: { id: "PR_thisOne" } },
            node: {
              __typename: "PullRequestReviewThread",
              id: "PRRT_other",
              threadPullRequest: { id: "PR_someOtherOne" },
            },
          },
        },
      ]);
      const cli = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const target = {
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
        threadId: "PRRT_other",
      };

      const error = yield* Effect.flip(
        write.body === undefined
          ? cli.setReviewThreadResolution({ ...target, resolved: write.resolved })
          : cli.replyToReviewThread({ ...target, body: write.body }),
      );

      assert.strictEqual(error._tag, "GitHubSubjectScopeError");
      expect(variablesOf(write.mutation)).toEqual([]);
    }),
  );
});
