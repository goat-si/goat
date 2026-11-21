import { GitCommandError } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { readFirstFetchUrl } from "./firstFetchUrl.ts";

const isGitCommandError = Schema.is(GitCommandError);

it.effect("reads only the first configured fetch URL and retains absent and error outcomes", () =>
  Effect.gen(function* () {
    const output = (stdout: string, stdoutTruncated = false) => ({
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout,
      stderr: "",
      stdoutTruncated,
      stderrTruncated: false,
    });
    const git = { execute: () => Effect.succeed(output("https://first/repo\nssh://last/repo\n")) };
    assert.strictEqual(yield* readFirstFetchUrl(git, "/repo", "origin"), "https://first/repo");
    assert.strictEqual(
      yield* readFirstFetchUrl(
        { execute: () => Effect.succeed(output("ssh://only/repo\n")) },
        "/repo",
        "origin",
      ),
      "ssh://only/repo",
    );
    assert.isNull(
      yield* readFirstFetchUrl({ execute: () => Effect.succeed(output("")) }, "/repo", "origin"),
    );
    assert.isTrue(
      isGitCommandError(
        yield* Effect.flip(
          readFirstFetchUrl(
            { execute: () => Effect.succeed(output("partial", true)) },
            "/repo",
            "origin",
          ),
        ),
      ),
    );
    const failure = new GitCommandError({
      operation: "test",
      command: "git config",
      cwd: "/repo",
      detail: "failed",
    });
    assert.strictEqual(
      yield* Effect.flip(
        readFirstFetchUrl({ execute: () => Effect.fail(failure) }, "/repo", "origin"),
      ),
      failure,
    );
  }),
);
