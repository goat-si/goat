import { assert, describe, it } from "@effect/vitest";
import { GitCommandError } from "@goat/contracts";
import * as SourceControlHost from "@goat/source-control-core/server/SourceControlHost";
import * as Effect from "effect/Effect";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import { node, remotesOutput, restResponse } from "./GitHubSourceControlProviderTestFixtures.ts";
import { harness } from "./GitHubSourceControlProvider.testkit.ts";

describe("GitHub first fetch URL", () => {
  it.effect("preserves a failed config read as a visible checkout error", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      graphql: () => ({ pullRequest: node(7, "feature", "someone") }),
      api: {
        rest: (input) => {
          const fullName = input.path.slice("repos/".length);
          return Effect.succeed(
            restResponse({
              full_name: fullName,
              html_url: `https://github.com/${fullName}`,
              ssh_url: `git@github.com:${fullName}.git`,
              default_branch: "main",
            }),
          );
        },
      },
    });
    return Effect.gen(function* () {
      const host = yield* SourceControlHost.SourceControlHost;
      const gh = yield* GitHubSourceControlProvider.make.pipe(
        Effect.provideService(SourceControlHost.SourceControlHost, {
          ...host,
          git: {
            ...host.git,
            execute: () =>
              Effect.fail(
                new GitCommandError({
                  operation: "test",
                  command: "git config",
                  cwd: "/repo",
                  detail: "failed",
                }),
              ),
          },
        }),
      );
      const error = yield* Effect.flip(gh.checkoutChangeRequest({ cwd: "/repo", reference: "7" }));
      assert.strictEqual(error._tag, "SourceControlProviderError");
      assert.isFalse(git.some(([name]) => name === "ensureRemote"));
    }).pipe(Effect.provide(layer));
  });
  it.effect("uses the HTTPS fallback when origin has no configured fetch URL", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      originUrls: "",
      graphql: () => ({ pullRequest: node(7, "feature", "someone") }),
      api: {
        rest: (input) => {
          const fullName = input.path.slice("repos/".length);
          return Effect.succeed(
            restResponse({
              full_name: fullName,
              html_url: `https://github.com/${fullName}`,
              ssh_url: `git@github.com:${fullName}.git`,
              default_branch: "main",
            }),
          );
        },
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({ cwd: "/repo", reference: "7" });
      assert.deepStrictEqual(git.find(([name]) => name === "ensureRemote")?.[1], {
        cwd: "/repo",
        preferredName: "someone",
        url: "https://github.com/someone/web",
      });
    }).pipe(Effect.provide(layer));
  });
  it.effect("chooses the first configured fetch URL for a fork's clone protocol", () => {
    const { layer, git } = harness({
      remotes: remotesOutput(["origin", "git@github.com:acme/web.git"]),
      originUrls: "https://github.com/acme/web.git\ngit@github.com:acme/web.git\n",
      graphql: () => ({ pullRequest: node(7, "feature", "someone") }),
      api: {
        rest: (input) => {
          const fullName = input.path.slice("repos/".length);
          return Effect.succeed(
            restResponse({
              full_name: fullName,
              html_url: `https://github.com/${fullName}`,
              ssh_url: `git@github.com:${fullName}.git`,
              default_branch: "main",
            }),
          );
        },
      },
    });
    return Effect.gen(function* () {
      const gh = yield* GitHubSourceControlProvider.make;
      yield* gh.checkoutChangeRequest({ cwd: "/repo", reference: "7" });
      assert.deepStrictEqual(git.find(([name]) => name === "ensureRemote")?.[1], {
        cwd: "/repo",
        preferredName: "someone",
        url: "https://github.com/someone/web",
      });
    }).pipe(Effect.provide(layer));
  });
});
