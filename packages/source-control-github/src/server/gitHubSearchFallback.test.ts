import { assert, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import {
  defaultCredential,
  layer,
  listedPullRequests,
  matches,
  mockedCredential,
  mockedExecute,
  output,
} from "./GitHubPullRequestApi.testkit.ts";

layer("GitHub search fallback", (it) => {
  it.effect("uses repository listing on a search 502 when the query is eligible", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedCredential.mockImplementation(defaultCredential);
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          matches(call, "PullRequestSearch")
            ? output('{"message":"Server Error"}', false, false, {}, 502)
            : output(listedPullRequests(2, 1)),
        ),
      );
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* api.listPullRequests({
        cwd: "/w",
        repository: "acme/web",
        host: "github.acme.dev",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 10,
      });
      expect(result.items.map((item) => item.number)).toEqual([1, 2]);
    }),
  );
  it.effect("does not return unfiltered listing for text search errors", () =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedCredential.mockImplementation(defaultCredential);
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          matches(call, "PullRequestSearch")
            ? output('{"message":"Server Error"}', false, false, {}, 502)
            : output(listedPullRequests(2, 1)),
        ),
      );
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const error = yield* api
        .listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.acme.dev",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          query: "flaky",
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GitHubApiResponseError", status: 502 });
      assert.isFalse(mockedExecute.mock.calls.some(([call]) => matches(call, "PullRequestList")));
    }),
  );
  it.effect.each([
    { status: 404, cursor: undefined },
    { status: 502, cursor: { updatedBefore: "2026-01-01T00:00:00.000Z", delivered: 10 } },
  ])("does not fall back for a non-5xx response or a cursor (%j)", ({ status, cursor }) =>
    Effect.gen(function* () {
      mockedExecute.mockReset();
      mockedCredential.mockImplementation(defaultCredential);
      mockedExecute.mockImplementation((call) =>
        Effect.succeed(
          matches(call, "PullRequestSearch")
            ? output('{"message":"Error"}', false, false, {}, status)
            : output(listedPullRequests(2, 1)),
        ),
      );
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const result = yield* api
        .listPullRequests({
          cwd: "/w",
          repository: "acme/web",
          host: "github.acme.dev",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          ...(cursor ? { cursor } : {}),
        })
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(mockedExecute.mock.calls.some(([call]) => matches(call, "PullRequestList")));
    }),
  );
});
