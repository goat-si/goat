import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const output = (body: unknown) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: JSON.stringify(body),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
});
const remove = {
  cwd: "/w",
  repository: "acme/web",
  number: 7,
  content: "thumbs-up",
  reacted: false,
} as const;

it.effect("removes a later-page award and stops on an empty page", () =>
  Effect.gen(function* () {
    const page = [{ id: 1, name: "thumbsup", user: { username: "other" } }];
    const execute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();
    execute
      .mockReturnValueOnce(Effect.succeed(output({ username: "bilal" })))
      .mockReturnValueOnce(Effect.succeed(output(page)))
      .mockReturnValueOnce(
        Effect.succeed(output([{ id: 500, name: "thumbsup", user: { username: "bilal" } }])),
      )
      .mockReturnValueOnce(Effect.succeed(output({})));
    execute
      .mockReturnValueOnce(Effect.succeed(output({ username: "bilal" })))
      .mockReturnValueOnce(Effect.succeed(output(page)))
      .mockReturnValueOnce(Effect.succeed(output([])));
    const cli = yield* GitLabPullRequestCli.make.pipe(
      Effect.provide(Layer.mock(GitLabCli.GitLabCli)({ execute })),
    );
    yield* cli.setReaction(remove);
    yield* cli.setReaction(remove);
    expect(execute.mock.calls.map(([call]) => call.args[1])).toEqual([
      "user",
      "projects/acme%2Fweb/merge_requests/7/award_emoji?per_page=100&page=1",
      "projects/acme%2Fweb/merge_requests/7/award_emoji?per_page=100&page=2",
      "projects/acme%2Fweb/merge_requests/7/award_emoji/500",
      "user",
      "projects/acme%2Fweb/merge_requests/7/award_emoji?per_page=100&page=1",
      "projects/acme%2Fweb/merge_requests/7/award_emoji?per_page=100&page=2",
    ]);
  }),
);

it.effect("fails visibly at the page cap when a host never returns an empty page", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();
    execute.mockImplementation(({ args }) =>
      Effect.succeed(
        output(
          args[1] === "user"
            ? { username: "bilal" }
            : [{ id: 1, name: "thumbsup", user: { username: "other" } }],
        ),
      ),
    );
    const cli = yield* GitLabPullRequestCli.make.pipe(
      Effect.provide(Layer.mock(GitLabCli.GitLabCli)({ execute })),
    );
    const error = yield* cli.setReaction(remove).pipe(Effect.flip);
    expect(error._tag).toBe("GitLabMergeRequestReadError");
    expect(execute.mock.calls.length).toBeLessThanOrEqual(101);
  }),
);
