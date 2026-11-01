import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
// @effect-diagnostics nodeBuiltinImport:off -- fixture paths follow the host platform.
import * as NodePath from "node:path";

export const runGit = Effect.fn("GitManager.test.runGit")(function* (
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "GitManager.test.runGit",
    cwd,
    args,
    allowNonZeroExit,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
});

export const initRepo = Effect.fn("test.initRepo")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* runGit(cwd, ["init", "--initial-branch=main"]);
  yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
  yield* runGit(cwd, ["config", "user.name", "Test User"]);
  // A machine-global core.autocrlf=true must not alter exact-content fixtures.
  yield* runGit(cwd, ["config", "core.autocrlf", "false"]);
  yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
  yield* runGit(cwd, ["add", "README.md"]);
  yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
});
