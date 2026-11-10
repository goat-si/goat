import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeRestorePending } from "./goat/restorePending.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-turn-restore-" });
  const workspaceRoot = path.join(root, "project");
  const worktreesDir = path.join(root, "worktrees");
  const worktreePath = path.join(worktreesDir, "project", "restore");
  yield* fileSystem.makeDirectory(workspaceRoot);
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    driver
      .execute({ operation: "test.turnRestore", cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));
  yield* git(workspaceRoot, ["init", "-b", "main"]);
  yield* git(workspaceRoot, ["config", "user.name", "Test"]);
  yield* git(workspaceRoot, ["config", "user.email", "test@example.com"]);
  yield* git(workspaceRoot, ["commit", "--allow-empty", "-m", "base"]);
  yield* git(workspaceRoot, ["worktree", "add", "-b", "feature/restore", worktreePath]);
  yield* git(worktreePath, ["commit", "--allow-empty", "-m", "thread work"]);
  const harness = () =>
    makeLocalCommandHarness({
      text: "Continue",
      workspaceRoot,
      worktreePath,
      worktreesDir,
      fileSystem,
      gitWorkflow,
      failReadsAfterRunning: true,
    });
  return { fileSystem, git, workspaceRoot, worktreePath, harness };
});

const notices = (harness: ReturnType<typeof makeLocalCommandHarness>) =>
  harness
    .projection()
    .turnItems.flatMap((item) =>
      item.type === "notification" ? [{ summary: item.summary, detail: item.detail }] : [],
    );

it.effect("a turn that recreates its removed worktree says what did not come back", () =>
  Effect.gen(function* () {
    const { fileSystem, git, workspaceRoot, worktreePath, harness } = yield* setup;
    yield* fileSystem.remove(worktreePath, { recursive: true });
    yield* git(workspaceRoot, ["worktree", "prune"]);
    const turn = harness();
    yield* turn.start;
    expect(turn.open).toHaveBeenCalledOnce();
    expect(notices(turn)).toEqual([
      {
        summary: "Recreated the worktree from branch feature/restore.",
        detail: "Changes that were never committed are not in it.",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);

it.effect(
  "a turn after a restore stopped during setup starts the agent and finishes the restore",
  () =>
    Effect.gen(function* () {
      const { git, worktreePath, harness } = yield* setup;
      const pending = yield* makeRestorePending;
      yield* pending.write(worktreePath, {
        restoredFrom: "branch",
        headSha: yield* git(worktreePath, ["rev-parse", "HEAD~1"]),
        snapshotSha: null,
        snapshotRef: null,
      });
      const turn = harness();
      yield* turn.start;
      expect(turn.open).toHaveBeenCalledOnce();
      expect(yield* pending.ready(worktreePath)).toBe(true);
      expect(turn.projection().runs.at(-1)?.status).toBe("running");
    }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
