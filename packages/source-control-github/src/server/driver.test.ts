import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeIsRepositoryStarred } from "./driver.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

describe("makeIsRepositoryStarred", () => {
  it.effect(
    "is true only on 204, false for a missing or foreign repository, and propagates unrelated failures",
    () => {
      const paths: Array<string> = [];
      const api = Layer.mock(GitHubRest.GitHubRest)({
        rest: (input) => {
          paths.push(input.path);
          if (input.path === "user/starred/goat-si/goat") {
            return Effect.succeed({
              status: 204,
              headers: {},
              body: "",
              truncated: false,
              invalidUtf8: false,
            });
          }
          // Only goat-si/goat reaches the API; other repository arguments never call it.
          return Effect.fail(
            new GitHubRequestPolicy.GitHubApiNotFoundError({
              host: input.host,
              operation: input.operation,
            }),
          );
        },
      });
      return Effect.gen(function* () {
        const isStarred = yield* makeIsRepositoryStarred;
        assert.isTrue(yield* isStarred("github.com", "goat-si/goat"));
        assert.isFalse(yield* isStarred("github.com", "goat-si/missing"));
        assert.isFalse(yield* isStarred("github.com", "other/repo"));
        assert.isFalse(yield* isStarred("github.com", "goat-si/goat/../../user"));
        assert.deepStrictEqual(paths, ["user/starred/goat-si/goat"]);
      }).pipe(Effect.provide(api));
    },
  );

  it.effect("propagates non-404 failures", () => {
    const failure = new GitHubRequestPolicy.GitHubApiAuthenticationError({
      host: "github.com",
      operation: "isRepositoryStarred",
    });
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: () => Effect.fail(failure),
    });
    return Effect.gen(function* () {
      const isStarred = yield* makeIsRepositoryStarred;
      const exit = yield* Effect.exit(isStarred("github.com", "goat-si/goat"));
      const tag: unknown = (exit as { _tag?: unknown })._tag;
      assert.strictEqual(tag, "Failure");
      const failed = exit._tag === "Failure" ? exit : null;
      assert.isTrue(failed !== null && failed.cause !== undefined);
    }).pipe(Effect.provide(api));
  });
});
