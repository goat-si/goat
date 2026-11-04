// @effect-diagnostics nodeBuiltinImport:off -- real Git fixtures run in temporary repositories.
import { assert, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId, type WorktreeSnapshot } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import { WorktreeSnapshotStore } from "../../worktreeSnapshots/WorktreeSnapshotStore.ts";
import { layerRealGit } from "../ProviderTurnStartService.testkit.ts";
import { makeRestorePending, makeRestoreThreadWorkspace } from "./restoreThreadWorkspace.ts";

const threadId = ThreadId.make("thread-restore");

const fixture = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-restore-test-"))),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const repo = NodePath.join(root, "repo");
  const worktreePath = NodePath.join(root, "worktree");
  NodeFS.mkdirSync(repo);
  const git = (cwd: string, args: string[], index?: string) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      env: { ...process.env, ...(index ? { GIT_INDEX_FILE: index } : {}) },
      encoding: "utf8",
    }).trim();
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  NodeFS.writeFileSync(NodePath.join(repo, "tracked"), "base");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "base"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-b", "feature", worktreePath]);
  NodeFS.writeFileSync(NodePath.join(worktreePath, "tracked"), "changed");
  NodeFS.writeFileSync(NodePath.join(worktreePath, "untracked"), "new");
  const indexCommit = git(worktreePath, [
    "commit-tree",
    git(worktreePath, ["write-tree"]),
    "-p",
    headSha,
    "-m",
    "index",
  ]);
  const index = NodePath.join(root, "index");
  NodeFS.copyFileSync(
    git(worktreePath, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
    index,
  );
  git(worktreePath, ["add", "-A"], index);
  const tree = git(worktreePath, ["write-tree"], index);
  const snapshotSha = git(worktreePath, [
    "commit-tree",
    tree,
    "-p",
    headSha,
    "-p",
    indexCommit,
    "-m",
    "snapshot",
  ]);
  const snapshotRef = "refs/goat/snapshots/thread-restore/one";
  git(repo, ["update-ref", snapshotRef, snapshotSha]);
  git(repo, ["worktree", "remove", "--force", worktreePath]);
  const snapshot: WorktreeSnapshot = {
    threadId,
    worktreePath,
    branch: "feature",
    baseRef: null,
    headSha,
    snapshotRef,
    snapshotSha,
    createdAt: "2026-06-10T12:00:00.000Z",
    reason: "Inactive for 9 days",
  };
  return { repo, worktreePath, git, snapshot };
});

const services = (
  snapshot: WorktreeSnapshot,
  restored: string[],
  setupExitCode: number | null,
  onSetup: (worktreePath: string) => void = () => {},
) =>
  Layer.mergeAll(
    Layer.succeed(WorktreeSnapshotStore, {
      capture: () => Effect.die("unused"),
      latestForThread: () => Effect.succeed(snapshot),
      markRestored: (ref) => Effect.sync(() => void restored.push(ref)),
      deleteForThread: () => Effect.succeed(0),
      purgeDeletedThreads: () => Effect.succeed(0),
      expire: () => Effect.succeed(0),
    }),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: (input) =>
        Effect.sync(() => {
          onSetup(input.worktreePath);
          return setupExitCode === null
            ? { status: "no-script" as const }
            : {
                status: "started" as const,
                scriptId: "setup",
                scriptName: "setup",
                scriptCommand: "true",
                terminalId: "terminal-1",
                cwd: input.worktreePath,
                async: false,
                // Like the real runner, the exit code is reported only to a caller that asks.
                ...(input.observeCompletion === undefined
                  ? {}
                  : { completion: Effect.succeed({ exitCode: setupExitCode, durationMs: 1 }) }),
              };
        }),
    }),
  );

it.effect("brings back the snapshot's changes, reruns setup and records the restore", () =>
  Effect.gen(function* () {
    const { repo, worktreePath, git, snapshot } = yield* fixture;
    const restored: string[] = [];
    const restore = yield* makeRestoreThreadWorkspace.pipe(
      Effect.provide(services(snapshot, restored, 0)),
    );
    const result = yield* restore({ threadId, cwd: repo, worktreePath, branch: "feature" });
    assert.deepEqual(result, {
      restoredFrom: "snapshot",
      headSha: snapshot.headSha,
      setupScript: "started",
    });
    assert.equal(NodeFS.readFileSync(NodePath.join(worktreePath, "tracked"), "utf8"), "changed");
    assert.equal(NodeFS.readFileSync(NodePath.join(worktreePath, "untracked"), "utf8"), "new");
    assert.equal(git(worktreePath, ["symbolic-ref", "HEAD"]), "refs/heads/feature");
    assert.deepEqual(restored, [snapshot.snapshotRef]);
  }).pipe(Effect.provide(layerRealGit), Effect.scoped),
);

it.effect(
  "a failed setup script leaves no worktree behind, so the next attempt restores again",
  () =>
    Effect.gen(function* () {
      const { repo, worktreePath, snapshot } = yield* fixture;
      const restored: string[] = [];
      const restore = yield* makeRestoreThreadWorkspace.pipe(
        Effect.provide(services(snapshot, restored, 1)),
      );
      const error = yield* Effect.flip(
        restore({ threadId, cwd: repo, worktreePath, branch: "feature" }),
      );
      assert.equal(error.reason, "setup-failed");
      assert.deepEqual(restored, []);
      // Nothing is left that would look present and let the next attempt skip restoring.
      assert.isFalse(NodeFS.existsSync(worktreePath));
      const retry = yield* makeRestoreThreadWorkspace.pipe(
        Effect.provide(services(snapshot, restored, 0)),
      );
      yield* retry({ threadId, cwd: repo, worktreePath, branch: "feature" });
      assert.equal(NodeFS.readFileSync(NodePath.join(worktreePath, "untracked"), "utf8"), "new");
      assert.deepEqual(restored, [snapshot.snapshotRef]);
    }).pipe(Effect.provide(layerRealGit), Effect.scoped),
);

it.effect(
  "a rollback that cannot remove the worktree leaves it unready, so the next attempt prepares it again",
  () =>
    Effect.gen(function* () {
      const { repo, worktreePath, git, snapshot } = yield* fixture;
      const restored: string[] = [];
      // A locked worktree refuses a single --force, as an open handle can on Windows.
      const lock = (path: string) => void git(repo, ["worktree", "lock", path]);
      const failing = yield* makeRestoreThreadWorkspace.pipe(
        Effect.provide(services(snapshot, restored, 1, lock)),
      );
      const error = yield* Effect.flip(
        failing({ threadId, cwd: repo, worktreePath, branch: "feature" }),
      );
      assert.equal(error.reason, "setup-failed");
      assert.isTrue(NodeFS.existsSync(worktreePath));
      const pending = yield* makeRestorePending;
      assert.isFalse(yield* pending.ready(worktreePath));
      git(repo, ["worktree", "unlock", worktreePath]);
      const setups: string[] = [];
      const retry = yield* makeRestoreThreadWorkspace.pipe(
        Effect.provide(services(snapshot, restored, 0, (path) => void setups.push(path))),
      );
      const result = yield* retry({ threadId, cwd: repo, worktreePath, branch: "feature" });
      assert.equal(result.restoredFrom, "snapshot");
      assert.deepEqual(setups, [worktreePath]);
      assert.isTrue(yield* pending.ready(worktreePath));
      assert.equal(NodeFS.readFileSync(NodePath.join(worktreePath, "untracked"), "utf8"), "new");
      assert.deepEqual(restored, [snapshot.snapshotRef]);
    }).pipe(Effect.provide(layerRealGit), Effect.scoped),
);

it.effect("refuses to restore onto a branch that moved since the snapshot", () =>
  Effect.gen(function* () {
    const { repo, worktreePath, git, snapshot } = yield* fixture;
    git(repo, ["commit", "--allow-empty", "-m", "moved"]);
    git(repo, ["branch", "-f", "feature", "HEAD"]);
    const restored: string[] = [];
    const restore = yield* makeRestoreThreadWorkspace.pipe(
      Effect.provide(services(snapshot, restored, null)),
    );
    const error = yield* Effect.flip(
      restore({ threadId, cwd: repo, worktreePath, branch: "feature" }),
    );
    assert.equal(error.reason, "snapshot-conflict");
    assert.isFalse(NodeFS.existsSync(worktreePath));
  }).pipe(Effect.provide(layerRealGit), Effect.scoped),
);
