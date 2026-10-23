import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellThreadStatus,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { tryWithWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";

interface ThreadFixture {
  readonly id: string;
  readonly worktreePath: string;
  readonly status?: OrchestrationV2ShellThreadStatus;
  readonly activeRunId?: string | null;
  readonly archived?: boolean;
}

const shell = (fixture: ThreadFixture) =>
  ({
    id: ThreadId.make(fixture.id),
    projectId: ProjectId.make("project-1"),
    title: "Thread " + fixture.id,
    branch: null,
    worktreePath: fixture.worktreePath,
    status: fixture.status ?? "completed",
    activeRunId: fixture.activeRunId ?? null,
    latestRunId: null,
    latestUserMessageAt: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
  }) as unknown as OrchestrationV2ThreadShell;

/**
 * A repository cloned from a bare origin, registered as the only project, with
 * GOAT's thread list and pull request lookup under the test's control.
 */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    git.execute({ operation: "worktree-inventory-test", cwd, args });
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "wt-inventory-" }));
  const origin = root + "/origin.git";
  const repo = root + "/repo";
  yield* run(root, ["init", "--bare", "-b", "main", origin]);
  yield* run(root, ["clone", origin, repo]);
  yield* run(repo, ["config", "user.email", "wt@example.test"]);
  yield* run(repo, ["config", "user.name", "Worktree test"]);
  yield* run(repo, ["commit", "--allow-empty", "-m", "initial"]);
  yield* run(repo, ["push", "origin", "HEAD:main"]);
  yield* fs.makeDirectory(config.worktreesDir, { recursive: true });
  const worktreesDir = yield* fs.realPath(config.worktreesDir);
  let threads: Array<ThreadFixture> = [];
  let mergedPullRequest: { branch: string; headSha: string } | null = null;
  // Runs while removal waits on the pull request lookup, between its checks and the deletion.
  let duringPullRequestLookup: Effect.Effect<void> = Effect.void;

  const addWorktree = (branch: string, at = worktreesDir + "/" + branch) =>
    run(repo, ["worktree", "add", "-b", branch, at]).pipe(Effect.as(at));
  const commit = (cwd: string) =>
    run(cwd, ["commit", "--allow-empty", "-m", "work"]).pipe(
      Effect.andThen(run(cwd, ["rev-parse", "HEAD"])),
      Effect.map((result) => result.stdout.trim()),
    );

  const context = yield* Layer.build(WorktreeInventoryService.layer).pipe(
    Effect.provideService(ThreadManagementService.ThreadManagementService, {
      getShellSnapshot: (options?: { location?: string }) =>
        Effect.sync(() => ({
          threads: threads
            .filter((thread) => (thread.archived === true) === (options?.location === "archive"))
            .map(shell),
          archivedThreads: [],
        })),
      getReviewLedgerEntries: () => Effect.die("unused review ledger query"),
      getThreadShell: (id: string) =>
        Effect.sync(() => {
          const thread = threads.find((entry) => entry.id === id);
          return thread === undefined ? null : shell(thread);
        }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    Effect.provideService(ProjectService.ProjectService, {
      listShells: () => Effect.succeed([{ id: ProjectId.make("project-1"), workspaceRoot: repo }]),
    } as unknown as ProjectService.ProjectService["Service"]),
    Effect.provideService(GitManager.GitManager, {
      branchPullRequest: (input: { branch: string }) =>
        duringPullRequestLookup.pipe(
          Effect.andThen(
            Effect.sync(() =>
              mergedPullRequest?.branch === input.branch
                ? {
                    number: 7,
                    state: "merged",
                    headRef: input.branch,
                    headSha: mergedPullRequest.headSha,
                  }
                : null,
            ),
          ),
        ),
    } as unknown as GitManager.GitManager["Service"]),
  );
  const service = Context.get(context, WorktreeInventoryService.WorktreeInventoryService);

  return {
    service,
    fs,
    repo,
    run,
    addWorktree,
    commit,
    setThreads: (next: Array<ThreadFixture>) => {
      threads = next;
    },
    setMergedPullRequest: (next: { branch: string; headSha: string } | null) => {
      mergedPullRequest = next;
    },
    setDuringPullRequestLookup: (next: Effect.Effect<void>) => {
      duringPullRequestLookup = next;
    },
    root,
  };
});

const testLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerSettings.layerTest({})),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "wt-inventory-config-" })),
  Layer.provideMerge(NodeServices.layer),
);

const refusal = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

describe("WorktreeInventoryService", () => {
  it.live("lists each worktree with its thread, uncommitted files, and unpushed commits", () =>
    Effect.gen(function* () {
      const { service, fs, addWorktree, commit, setThreads, repo } = yield* fixture;
      const path = yield* addWorktree("feature");
      yield* commit(path);
      yield* fs.writeFileString(path + "/scratch.txt", "draft\n");
      setThreads([{ id: "t1", worktreePath: path, status: "running", activeRunId: "run-1" }]);

      const { worktrees } = yield* service.inventory({});
      expect(worktrees.map((entry) => [entry.path, entry.main])).toEqual([
        [repo, true],
        [path, false],
      ]);
      const feature = worktrees[1]!;
      expect(feature).toMatchObject({
        branch: "feature",
        managed: true,
        missing: false,
        dirtyCount: 1,
        aheadCount: 1,
      });
      expect(feature.threads).toEqual([
        expect.objectContaining({ threadId: "t1", status: "running", busy: true }),
      ]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("never removes a worktree whose thread is busy, even with force", () =>
    Effect.gen(function* () {
      const { service, fs, addWorktree, setThreads } = yield* fixture;
      const path = yield* addWorktree("busy");
      setThreads([{ id: "t1", worktreePath: path, status: "waiting" }]);

      const message = yield* refusal(
        service.remove({ threadId: ThreadId.make("t1"), force: true }),
      );
      expect(message).toContain("is running or has pending work");
      expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("refuses the main checkout and paths outside any repository", () =>
    Effect.gen(function* () {
      const { service, repo } = yield* fixture;
      expect(yield* refusal(service.remove({ path: repo, force: true }))).toContain(
        "main checkout",
      );
      expect(yield* refusal(service.remove({ path: "/definitely/not/a/worktree" }))).toContain(
        "is not a git worktree",
      );
      expect(yield* refusal(service.remove({}))).toContain("exactly one of path or threadId");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("refuses uncommitted changes unless forced", () =>
    Effect.gen(function* () {
      const { service, fs, addWorktree, setThreads } = yield* fixture;
      const path = yield* addWorktree("dirty");
      yield* fs.writeFileString(path + "/scratch.txt", "draft\n");
      setThreads([{ id: "t1", worktreePath: path, status: "completed" }]);

      expect(yield* refusal(service.remove({ path }))).toContain("1 file with uncommitted changes");
      expect(yield* fs.exists(path)).toBe(true);

      const result = yield* service.remove({ path, force: true });
      expect(result.notes[0]).toContain("Forced past");
      expect(yield* fs.exists(path)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("refuses commits on no remote until they are pushed, then deletes the branch", () =>
    Effect.gen(function* () {
      const { service, fs, run, repo, addWorktree, commit } = yield* fixture;
      const path = yield* addWorktree("unpushed");
      yield* commit(path);

      expect(yield* refusal(service.remove({ path, deleteBranch: true }))).toContain(
        "1 commit on no remote",
      );
      yield* run(path, ["push", "origin", "unpushed"]);

      const result = yield* service.remove({ path, deleteBranch: true });
      expect(result).toMatchObject({ branch: "unpushed", branchDeleted: true });
      expect(yield* fs.exists(path)).toBe(false);
      const branches = yield* run(repo, ["branch", "--list", "unpushed"]);
      expect(branches.stdout.trim()).toBe("");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("promises a recreated checkout only where turn start would recreate it", () =>
    Effect.gen(function* () {
      const { service, fs, root, addWorktree, setThreads } = yield* fixture;
      const worktreesDir = yield* fs.realPath((yield* ServerConfig.ServerConfig).worktreesDir);
      const placed = yield* addWorktree("placed", worktreesDir + "/repo/placed");
      const outside = yield* addWorktree("outside", root + "/elsewhere/outside");
      setThreads([
        { id: "placed-thread", worktreePath: placed },
        { id: "outside-thread", worktreePath: outside },
      ]);

      const recreatable = yield* service.remove({ path: placed });
      expect(recreatable.notes).toEqual([
        "Thread placed-thread still points at this path; it recreates the checkout from branch placed if it runs again.",
      ]);
      const unmanaged = yield* service.remove({ path: outside });
      expect(unmanaged.notes).toHaveLength(1);
      expect(unmanaged.notes[0]).toContain("outside-thread");
      expect(unmanaged.notes[0]).toContain("will not recreate");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("accepts commits a merged pull request names after the remote branch is gone", () =>
    Effect.gen(function* () {
      const { service, fs, addWorktree, commit, setMergedPullRequest } = yield* fixture;
      const path = yield* addWorktree("squashed");
      const head = yield* commit(path);
      setMergedPullRequest({ branch: "squashed", headSha: head });

      yield* service.remove({ path });
      expect(yield* fs.exists(path)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("cleanup reports by default and removes only finished, saved worktrees", () =>
    Effect.gen(function* () {
      const { service, fs, addWorktree, commit, setThreads, repo } = yield* fixture;
      const finished = yield* addWorktree("finished");
      const archived = yield* addWorktree("archived");
      const idle = yield* addWorktree("idle");
      const unsaved = yield* addWorktree("unsaved");
      yield* commit(unsaved);
      const outside = yield* addWorktree("outside", repo + "-outside");
      const orphan = yield* addWorktree("orphan");
      setThreads([
        { id: "t-finished", worktreePath: finished, status: "failed" },
        { id: "t-archived", worktreePath: archived, status: "completed", archived: true },
        { id: "t-idle", worktreePath: idle, status: "idle" },
        { id: "t-unsaved", worktreePath: unsaved, status: "cancelled" },
      ]);

      const preview = yield* service.cleanup({});
      expect(preview.dryRun).toBe(true);
      expect(preview.removed.map((entry) => entry.path).toSorted()).toEqual(
        [archived, finished, orphan].toSorted(),
      );
      const kept = Object.fromEntries(preview.kept.map((entry) => [entry.path, entry.reason]));
      expect(kept[idle]).toContain("has not finished a run");
      expect(kept[unsaved]).toContain("1 commit on no remote");
      expect(kept[outside]).toContain("outside GOAT's worktrees folder");
      expect(yield* fs.exists(finished)).toBe(true);

      const swept = yield* service.cleanup({ dryRun: false });
      expect(swept.removed.map((entry) => entry.path).toSorted()).toEqual(
        [archived, finished, orphan].toSorted(),
      );
      for (const path of [archived, finished, orphan]) expect(yield* fs.exists(path)).toBe(false);
      for (const path of [idle, unsaved, outside]) expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("never deletes the default branch, even with force", () =>
    Effect.gen(function* () {
      const { service, fs, run, repo } = yield* fixture;
      yield* run(repo, ["remote", "set-head", "origin", "main"]);
      // The default branch can sit in a secondary worktree once the main checkout moves off it.
      yield* run(repo, ["switch", "-c", "elsewhere"]);
      const path = repo + "-main";
      yield* run(repo, ["worktree", "add", path, "main"]);

      const message = yield* refusal(service.remove({ path, force: true, deleteBranch: true }));
      expect(message).toContain("is the repository's default branch");
      expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("asks the remote for its default branch when none is recorded locally", () =>
    Effect.gen(function* () {
      const { service, fs, run, repo, root, addWorktree } = yield* fixture;
      // Cloned before origin had a branch, the clone recorded no origin/HEAD,
      // as a repository pushed after `git remote add` does.
      const path = yield* addWorktree("dev");
      yield* run(path, ["push", "origin", "dev"]);
      yield* run(root, [
        "--git-dir",
        root + "/origin.git",
        "symbolic-ref",
        "HEAD",
        "refs/heads/dev",
      ]);

      const message = yield* refusal(service.remove({ path, force: true, deleteBranch: true }));
      expect(message).toContain("branch dev is the repository's default branch");
      expect(yield* fs.exists(path)).toBe(true);

      // A pushed branch that is not the default is still deleted.
      const pushed = yield* addWorktree("pushed");
      yield* run(pushed, ["push", "origin", "pushed"]);
      const result = yield* service.remove({ path: pushed, deleteBranch: true });
      expect(result.branchDeleted).toBe(true);

      // When the remote cannot answer, any branch it also has is kept.
      yield* run(repo, ["remote", "set-url", "origin", root + "/unreachable.git"]);
      const offline = yield* addWorktree("offline");
      yield* run(repo, ["update-ref", "refs/remotes/origin/offline", "offline"]);
      const kept = yield* refusal(
        service.remove({ path: offline, force: true, deleteBranch: true }),
      );
      expect(kept).toContain("may be the repository's default branch");
      expect((yield* run(repo, ["branch", "--list", "offline"])).stdout.trim()).not.toBe("");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("keeps a branch with unsaved commits unless deleteUnsavedBranch is set", () =>
    Effect.gen(function* () {
      const { service, fs, run, repo, addWorktree, commit } = yield* fixture;
      const path = yield* addWorktree("only-copy");
      yield* commit(path);

      // force covers the checkout, not the branch that alone holds the commit.
      const message = yield* refusal(service.remove({ path, force: true, deleteBranch: true }));
      expect(message).toContain("deleteUnsavedBranch:true");
      expect(yield* fs.exists(path)).toBe(true);

      const result = yield* service.remove({
        path,
        force: true,
        deleteBranch: true,
        deleteUnsavedBranch: true,
      });
      expect(result.branchDeleted).toBe(true);
      expect((yield* run(repo, ["branch", "--list", "only-copy"])).stdout.trim()).toBe("");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("refuses repositories that belong to no GOAT project", () =>
    Effect.gen(function* () {
      const { service, fs, run, root } = yield* fixture;
      const stranger = root + "/stranger";
      yield* run(root, ["init", "-b", "main", stranger]);
      yield* run(stranger, [
        "-c",
        "user.email=s@example.test",
        "-c",
        "user.name=S",
        "commit",
        "--allow-empty",
        "-m",
        "s",
      ]);
      const path = root + "/stranger-wt";
      yield* run(stranger, ["worktree", "add", "-b", "side", path]);

      expect(yield* refusal(service.remove({ path, force: true }))).toContain(
        "is not a repository of a GOAT project",
      );
      expect(yield* refusal(service.cleanup({ repo: stranger, dryRun: false }))).toContain(
        "is not a repository of a GOAT project",
      );
      expect(yield* refusal(service.cleanup({ repo: "relative/repo" }))).toContain(
        "repo must be an absolute path",
      );
      expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("refuses a symlink to a worktree instead of following it", () =>
    Effect.gen(function* () {
      const { service, fs, root, addWorktree } = yield* fixture;
      const path = yield* addWorktree("aliased");
      const alias = root + "/alias";
      yield* fs.symlink(path, alias);

      expect(yield* refusal(service.remove({ path: alias, force: true }))).toContain(
        "is an alias of the worktree at " + path,
      );
      expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("refuses a thread's symlink as a path but removes it by threadId", () =>
    Effect.gen(function* () {
      const { service, fs, root, addWorktree, setThreads } = yield* fixture;
      const path = yield* addWorktree("bound-alias");
      const alias = root + "/bound-alias";
      yield* fs.symlink(path, alias);
      setThreads([{ id: "t1", worktreePath: alias, status: "completed" }]);

      // The thread's recorded symlink is not the worktree's own path.
      expect(yield* refusal(service.remove({ path: alias, force: true }))).toContain(
        "is an alias of the worktree at " + path,
      );
      expect(yield* fs.exists(path)).toBe(true);

      // Naming the thread is unambiguous, so its recorded path is accepted.
      const removed = yield* service.remove({ threadId: ThreadId.make("t1"), force: true });
      expect(removed.path).toBe(path);
      expect(yield* fs.exists(path)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("a thread bound through a symlink cannot remove a checkout another thread is using", () =>
    Effect.gen(function* () {
      const {
        service,
        fs,
        root,
        addWorktree,
        commit,
        setThreads,
        setMergedPullRequest,
        setDuringPullRequestLookup,
      } = yield* fixture;
      const path = yield* addWorktree("shared");
      const alias = root + "/shared-alias";
      yield* fs.symlink(path, alias);
      setMergedPullRequest({ branch: "shared", headSha: yield* commit(path) });
      setThreads([
        { id: "owner", worktreePath: path, status: "running", activeRunId: "run-1" },
        { id: "linked", worktreePath: alias, status: "completed" },
      ]);

      // The alias resolves to the owner's checkout, so the owner's run blocks removal.
      expect(
        yield* refusal(service.remove({ threadId: ThreadId.make("linked"), force: true })),
      ).toContain("thread owner (Thread owner) is running or has pending work");
      expect(yield* fs.exists(path)).toBe(true);

      setThreads([
        { id: "owner", worktreePath: path, status: "completed" },
        { id: "linked", worktreePath: alias, status: "completed" },
      ]);
      // A turn start leases its thread's recorded path, so both must be held while removing.
      const leased: Array<boolean> = [];
      setDuringPullRequestLookup(
        Effect.forEach([path, alias], (key) =>
          tryWithWorkspaceLease(key, Effect.void).pipe(
            Effect.map((acquired) => leased.push(Option.isNone(acquired))),
          ),
        ),
      );
      const removed = yield* service.remove({ threadId: ThreadId.make("linked") });
      expect(removed.path).toBe(path);
      expect(leased.length).toBeGreaterThan(0);
      expect(leased.every(Boolean)).toBe(true);
      expect(removed.notes).toContainEqual(expect.stringContaining("owner"));
      expect(yield* fs.exists(path)).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("rechecks the thread right before deleting, after the slow commit checks", () =>
    Effect.gen(function* () {
      const {
        service,
        fs,
        addWorktree,
        commit,
        setThreads,
        setMergedPullRequest,
        setDuringPullRequestLookup,
      } = yield* fixture;
      const path = yield* addWorktree("racing");
      const head = yield* commit(path);
      setMergedPullRequest({ branch: "racing", headSha: head });
      setThreads([{ id: "t1", worktreePath: path, status: "completed" }]);
      // The thread starts while removal waits on the pull request lookup.
      setDuringPullRequestLookup(
        Effect.sync(() =>
          setThreads([{ id: "t1", worktreePath: path, status: "starting", activeRunId: "run-2" }]),
        ),
      );

      expect(yield* refusal(service.remove({ path }))).toContain(
        "thread t1 started while this removal was checked",
      );
      expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});
