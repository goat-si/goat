import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProcessRunner from "../processRunner.ts";
import { unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";

/** The checkouts of the git repository at `directory`, or none outside a repository. */
export const listGitCheckouts = Effect.fn("cli.thread.listGitCheckouts")(function* (
  directory: string,
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const env = unsetInheritedRepositoryEnv(process.env, yield* HostProcess.Platform);
  const list = (args: ReadonlyArray<string>) =>
    processRunner
      .run({
        command: "git",
        args: ["worktree", "list", "--porcelain", ...args],
        cwd: directory,
        env,
      })
      .pipe(
        Effect.option,
        Effect.map((result) =>
          Option.isSome(result) && result.value.code === 0 ? result.value.stdout : undefined,
        ),
      );
  // Pre-2.36 Git rejects worktree list -z; normalize its line output to NUL records.
  const stdout = (yield* list(["-z"])) ?? (yield* list([]))?.replaceAll("\n", "\0") ?? "";
  return stdout.split("\0\0").flatMap((record) => {
    const [first = "", ...attributes] = record.split("\0");
    const prunable = attributes.some((attribute) => attribute.startsWith("prunable"));
    return first.startsWith("worktree ") && !attributes.includes("bare") && !prunable
      ? [first.slice("worktree ".length)]
      : [];
  });
});
