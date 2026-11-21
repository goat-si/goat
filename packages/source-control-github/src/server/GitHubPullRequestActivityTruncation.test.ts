import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import { lastPage } from "./gitHubPullRequestTestFixtures.ts";
import {
  defaultCredential,
  encodeJson,
  layer,
  mockedCredential,
  mockedExecute,
  mockedStackMemberships,
  output,
  pullRequestInput,
} from "./GitHubPullRequestApi.testkit.ts";

layer("activity pagination", (it) => {
  it.effect.each(["comments", "reviews"] as const)(
    "marks activity truncated when %s pages remain",
    (source) =>
      Effect.gen(function* () {
        mockedExecute.mockReset();
        mockedStackMemberships.mockReset();
        mockedCredential.mockReset();
        mockedCredential.mockImplementation(defaultCredential);
        mockedExecute.mockImplementation((call) => {
          const head = call.kind === "graphql" && call.variables?.["head"] === true;
          const more = { hasNextPage: true, endCursor: "next" };
          return Effect.succeed(
            output(
              encodeJson({
                data: {
                  repository: {
                    pullRequest: {
                      ...(head ? { author: null, commits: { nodes: [] } } : {}),
                      comments: { nodes: [], pageInfo: source === "comments" ? more : lastPage },
                      reviews: { nodes: [], pageInfo: source === "reviews" ? more : lastPage },
                    },
                  },
                },
              }),
            ),
          );
        });
        const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
        const activity = yield* api.getPullRequestActivity(pullRequestInput);
        expect(activity.truncated).toBe(true);
      }),
  );
});
