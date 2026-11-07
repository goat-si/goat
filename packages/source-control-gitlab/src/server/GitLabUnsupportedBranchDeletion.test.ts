import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";

it.effect("does not advertise or execute GitLab source-branch deletion", () => {
  const execute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();
  return Effect.gen(function* () {
    const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
    const provider = yield* GitLabPullRequestProvider.make.pipe(
      Effect.provideService(GitLabPullRequestCli.GitLabPullRequestCli, cli),
    );
    assert.notStrictEqual(provider.capabilities.deleteBranch, true);
    assert.isFalse(provider.capabilities.actions.includes("delete-branch"));
    const result = yield* Effect.exit(
      cli.runMergeRequestAction({
        cwd: "/repo",
        host: "gitlab.com",
        repository: "acme/web",
        number: 1,
        action: "delete-branch",
      }),
    );
    assert.isTrue(Exit.isFailure(result));
    assert.strictEqual(execute.mock.calls.length, 0);
  }).pipe(
    Effect.provide(
      GitLabPullRequestCli.layer.pipe(Layer.provide(Layer.mock(GitLabCli.GitLabCli)({ execute }))),
    ),
  );
});
