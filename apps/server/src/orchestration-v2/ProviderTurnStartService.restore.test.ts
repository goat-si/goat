import { ServerConfig } from "../config.ts";
import { ThreadId } from "@goat/contracts";
import * as PlatformError from "effect/PlatformError";
import { makeRestoreThreadWorkspace } from "./goat/restoreThreadWorkspace.ts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { makeRestorePending } from "./goat/restorePending.ts";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { layerRealGit } from "./ProviderTurnStartService.testkit.ts";
import { makeHarness as makeLaunchHarness } from "./testkit/ThreadLaunchHarness.ts";
import { launchInput } from "./testkit/threadLaunchInput.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitWorkflow = yield* GitWorkflow.GitWorkflowService;
  const { stateDir } = yield* ServerConfig;
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
      stateDir,
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

it.live("a launch bound during removal recreates the same worktree and announces it", () =>
  Effect.gen(function* () {
    const { fileSystem, workspaceRoot, worktreePath, harness } = yield* setup;
    const workflow = yield* GitWorkflow.GitWorkflowService;
    const scanned = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const bound = yield* Ref.make(false);
    const removal = yield* workflow
      .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: true }, () =>
        Ref.get(bound).pipe(
          Effect.flatMap((isBound) =>
            isBound
              ? Effect.die("holder was present at scan")
              : Deferred.succeed(scanned, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        ),
      )
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(scanned);
    const launchHarness = makeLaunchHarness();
    const launched = yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunchService.ThreadLaunchService;
      return yield* launches.launch(
        launchInput({
          command: "race-launch",
          thread: "thread-native-account-command",
          workspace: { type: "existing_worktree", worktreePath, branch: "feature/restore" },
        }),
      );
    }).pipe(Effect.provide(launchHarness.layer));
    expect(launched.projection.thread.worktreePath).toBe(worktreePath);
    yield* Ref.set(bound, true);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(removal);
    expect(yield* fileSystem.exists(worktreePath)).toBe(false);
    const turn = harness();
    yield* turn.start;
    expect(turn.open).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: launched.threadId,
        runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
      }),
    );
    expect(notices(turn)).toEqual([
      {
        summary: "Recreated the worktree from branch feature/restore.",
        detail: "Changes that were never committed are not in it.",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
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

it.effect("names the preserved files when a busy worktree cannot put its leftovers back", () =>
  Effect.gen(function* () {
    const { fileSystem: fs, git, workspaceRoot, worktreePath } = yield* setup;
    const path = yield* Path.Path;
    yield* fs.remove(worktreePath, { recursive: true });
    yield* git(workspaceRoot, ["worktree", "prune"]);
    const leftovers = path.join(worktreePath, "node_modules");
    yield* fs.makeDirectory(leftovers, { recursive: true });
    yield* fs.writeFileString(path.join(leftovers, "keep.txt"), "keep");
    const busy = PlatformError.systemError({
      _tag: "Busy",
      module: "FileSystem",
      method: "rename",
    });
    const restore = yield* makeRestoreThreadWorkspace.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        rename: (from, to) =>
          from === worktreePath || to === leftovers ? Effect.fail(busy) : fs.rename(from, to),
      }),
    );
    const error = yield* Effect.flip(
      restore({
        threadId: ThreadId.make("busy-restore"),
        cwd: path.join(workspaceRoot, "missing-repository"),
        worktreePath,
        branch: "feature/restore",
      }),
    );
    const parent = path.dirname(worktreePath);
    const aside = (yield* fs.readDirectory(parent)).find((name) =>
      name.startsWith("restore-set-aside-"),
    );
    expect(aside).toBeDefined();
    const setAsidePath = path.join(parent, aside ?? "");
    expect(yield* fs.readFileString(path.join(setAsidePath, "node_modules", "keep.txt"))).toBe(
      "keep",
    );
    expect(error.message).toContain(setAsidePath);
  }).pipe(Effect.scoped, Effect.provide(layerRealGit)),
);
