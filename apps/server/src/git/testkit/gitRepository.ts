import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { makeTempDir } from "./fileFixtures.ts";
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

/** A committed repository and an empty bare remote, built once and copied into each test. */
export class GitFixtureTemplates extends Context.Service<
  GitFixtureTemplates,
  { readonly repo: string; readonly bareRemote: string }
>()("goat/git/testkit/gitRepository/GitFixtureTemplates") {}

export const layerGitFixtureTemplates = Layer.effect(
  GitFixtureTemplates,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* makeTempDir("goat-git-template-");
    // An empty template skips copying git's sample hooks into every test repository.
    yield* runGit(repo, ["init", "--initial-branch=main", "--template="]);
    yield* runGit(repo, ["config", "user.email", "test@example.com"]);
    yield* runGit(repo, ["config", "user.name", "Test User"]);
    // A machine-global core.autocrlf=true must not alter exact-content fixtures.
    yield* runGit(repo, ["config", "core.autocrlf", "false"]);
    yield* fs.writeFileString(NodePath.join(repo, "README.md"), "hello\n");
    yield* runGit(repo, ["add", "README.md"]);
    yield* runGit(repo, ["commit", "-m", "Initial commit"]);
    const bareRemote = yield* makeTempDir("goat-git-remote-template-");
    yield* runGit(bareRemote, ["init", "--bare", "--template="]);
    yield* fs.makeDirectory(NodePath.join(bareRemote, "hooks"), { recursive: true });
    return { repo, bareRemote };
  }),
);

export const initRepo = Effect.fn("test.initRepo")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const templates = yield* GitFixtureTemplates;
  for (const entry of [".git", "README.md"]) {
    yield* fs.copy(NodePath.join(templates.repo, entry), NodePath.join(cwd, entry));
  }
});
