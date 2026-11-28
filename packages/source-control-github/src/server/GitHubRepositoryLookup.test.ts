import { userFacingSourceControlDetail } from "@goat/source-control-core/server/SourceControlProvider";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import { restResponse } from "./GitHubSourceControlProviderTestFixtures.ts";
import { makeProvider } from "./GitHubSourceControlProvider.testkit.ts";

it.effect("exposes only fixed repository lookup details with the resolved owner", () =>
  Effect.gen(function* () {
    const gh = yield* makeProvider({
      rest: (input) =>
        input.path === "user"
          ? Effect.succeed(restResponse({ login: "me" }))
          : input.path === "repos/me/private"
            ? Effect.fail(
                new GitHubRequestPolicy.GitHubApiAuthenticationError({
                  host: input.host,
                  operation: input.operation,
                }),
              )
            : Effect.fail(
                new GitHubRequestPolicy.GitHubApiNotFoundError({
                  host: input.host,
                  operation: input.operation,
                }),
              ),
    });
    for (const repository of ["vouch", "other/vouch"]) {
      const error = yield* Effect.flip(gh.getRepositoryCloneUrls({ cwd: "/repo", repository }));
      assert.strictEqual(
        userFacingSourceControlDetail(error.cause),
        `Repository ${repository === "vouch" ? "me/vouch" : repository} was not found. Check the owner and name and try again.`,
      );
    }
    const authError = yield* Effect.flip(
      gh.getRepositoryCloneUrls({ cwd: "/repo", repository: "me/private" }),
    );
    assert.strictEqual(userFacingSourceControlDetail(authError.cause), undefined);
  }),
);
