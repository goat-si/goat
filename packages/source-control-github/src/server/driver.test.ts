import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeIsRepositoryStarred, makeStarRepository } from "./driver.ts";
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
        const star = yield* makeStarRepository;
        assert.isTrue(yield* isStarred("github.com", "goat-si/goat"));
        assert.isFalse(yield* isStarred("github.com", "goat-si/missing"));
        assert.isFalse(yield* isStarred("github.com", "other/repo"));
        assert.isFalse(yield* isStarred("github.com", "goat-si/goat/../../user"));
        assert.isFalse(yield* isStarred("github.com", "../repos"));
        assert.isFalse(yield* isStarred("github.com", "a/b/c"));
        assert.isTrue(yield* star("github.com", "goat-si/goat"));
        assert.isFalse(yield* star("github.com", "goat-si/missing"));
        assert.isFalse(yield* star("github.com", "other/repo"));
        assert.isFalse(yield* star("github.com", "goat-si/goat/../../user"));
        assert.isFalse(yield* star("github.com", "../repos"));
        assert.isFalse(yield* star("github.com", "a/b/c"));
        assert.deepStrictEqual(paths, ["user/starred/goat-si/goat", "user/starred/goat-si/goat"]);
      }).pipe(Effect.provide(api));
    },
  );

  it.effect("returns false when GitHub reports the star was not found", () => {
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: () =>
        Effect.fail(
          new GitHubRequestPolicy.GitHubApiNotFoundError({
            host: "github.com",
            operation: "isRepositoryStarred",
          }),
        ),
    });
    return Effect.gen(function* () {
      const isStarred = yield* makeIsRepositoryStarred;
      assert.isFalse(yield* isStarred("github.com", "goat-si/goat"));
    }).pipe(Effect.provide(api));
  });

  it.effect("star is false on failure and false for a foreign repository", () => {
    const paths: Array<string> = [];
    const failure = new GitHubRequestPolicy.GitHubApiAuthenticationError({
      host: "github.com",
      operation: "starRepository",
    });
    const api = Layer.mock(GitHubRest.GitHubRest)({
      rest: (input) => {
        paths.push(input.method === "PUT" ? `PUT ${input.path}` : input.path);
        return Effect.fail(failure);
      },
    });
    return Effect.gen(function* () {
      const star = yield* makeStarRepository;
      assert.isFalse(yield* star("github.com", "goat-si/goat"));
      assert.isFalse(yield* star("github.com", "other/repo"));
      assert.deepStrictEqual(paths, ["PUT user/starred/goat-si/goat"]);
    }).pipe(Effect.provide(api));
  });

  it.effect.each([
    new GitHubRequestPolicy.GitHubApiAuthenticationError({
      host: "github.com",
      operation: "check",
    }),
    new GitHubRequestPolicy.GitHubApiRequestError({
      host: "github.com",
      operation: "check",
      cause: "offline",
    }),
    new GitHubRequestPolicy.GitHubApiRateLimitError({ host: "github.com", operation: "check" }),
  ])("returns unavailable for failed checks: %s", (failure) => {
    const api = Layer.mock(GitHubRest.GitHubRest)({ rest: () => Effect.fail(failure) });
    return Effect.gen(function* () {
      const isStarred = yield* makeIsRepositoryStarred;
      assert.isNull(yield* isStarred("github.com", "goat-si/goat"));
    }).pipe(Effect.provide(api));
  });
});
