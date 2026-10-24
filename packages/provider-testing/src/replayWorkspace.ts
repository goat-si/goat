// @effect-diagnostics-next-line nodeBuiltinImport:off -- FileSystem.remove has no retry option.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isolatedGitEnv } from "@goat/shared/testing/gitEnv";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

class ReplayFixtureGitCommandError extends Schema.TaggedError<ReplayFixtureGitCommandError>()(
  "ReplayFixtureGitCommandError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.command} failed with exit ${this.exitCode}.`;
  }
}

function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  void,
  ReplayFixtureGitCommandError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make("git", ["-C", cwd, ...args], { cwd, env: isolatedGitEnv() }),
    );
    if (Number(exitCode) !== 0) {
      return yield* new ReplayFixtureGitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: Number(exitCode),
      });
    }
  });
}

export type ReplayWorkspaceFiles = Readonly<Record<string, string>>;

const makeCheckpointWorkspaceEffect = Effect.fn("makeCheckpointWorkspace")(function* (
  fixtureName: string,
  files: ReplayWorkspaceFiles = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectory({
    prefix: `goat-orchestrator-v2-${fixtureName}-`,
  });
  yield* runGit(cwd, ["init"]);
  const gitConfig = path.join(cwd, ".git", "config");
  yield* runGit(cwd, ["config", "--file", gitConfig, "user.name", "T3 Code Test"]);
  yield* runGit(cwd, ["config", "--file", gitConfig, "user.email", "t3code-test@example.com"]);
  yield* fs.writeFileString(path.join(cwd, "README.md"), `# ${fixtureName}\n`);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(cwd, relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  }
  yield* runGit(cwd, ["add", "README.md", ...Object.keys(files)]);
  yield* runGit(cwd, ["commit", "-m", "initial"]);
  return cwd;
});

const removeCheckpointWorkspaceEffect = Effect.fn("removeCheckpointWorkspace")(function* (
  cwd: string,
) {
  // Windows refuses to remove a directory that is still a process's cwd. After a session
  // release the replay agent can finish exiting just after the test's scope closes, so let
  // Node retry EBUSY on its own timers (the test clock may be paused). A process that never
  // exits still fails the removal. Whether release should await that exit: #1164.
  // The release already dies on failure, so a rejection is a defect here.
  yield* Effect.promise(() =>
    NodeFS.promises.rm(cwd, { recursive: true, maxRetries: 10, retryDelay: 50 }),
  );
});

export const checkpointWorkspace = (fixtureName: string, files?: ReplayWorkspaceFiles) =>
  Effect.acquireRelease(makeCheckpointWorkspaceEffect(fixtureName, files), (cwd) =>
    removeCheckpointWorkspaceEffect(cwd).pipe(Effect.orDie),
  ).pipe(Effect.provide(NodeServices.layer));

export async function makeCheckpointWorkspace(
  fixtureName: string,
  files?: ReplayWorkspaceFiles,
): Promise<string> {
  return await Effect.runPromise(
    makeCheckpointWorkspaceEffect(fixtureName, files).pipe(Effect.provide(NodeServices.layer)),
  );
}
