import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellThreadStatus,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { tryWithWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import { makeSweepRounds } from "./WorktreeSweepRounds.ts";

interface ThreadFixture {
  readonly id: string;
  readonly worktreePath: string;
  readonly status?: OrchestrationV2ShellThreadStatus;
  readonly activeRunId?: string | null;
  readonly archived?: boolean;
  readonly branch?: string;
}

const shell = (fixture: ThreadFixture) =>
  ({
    id: ThreadId.make(fixture.id),
    projectId: ProjectId.make("project-1"),
    title: "Thread " + fixture.id,
    branch: fixture.branch ?? null,
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
  let mergedPullRequests: Array<{ branch: string; headSha: string }> = [];
  // Runs while removal waits on the pull request lookup, between its checks and the deletion.
  let duringPullRequestLookup: Effect.Effect<void> = Effect.void;
  // Runs while a sweep lists the projects, before any worktree is checked.
  let duringScan: Effect.Effect<void> = Effect.void;

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
      listShells: () =>
        duringScan.pipe(Effect.as([{ id: ProjectId.make("project-1"), workspaceRoot: repo }])),
    } as unknown as ProjectService.ProjectService["Service"]),
    Effect.provideService(GitManager.GitManager, {
      branchPullRequest: (input: { branch: string }) =>
        duringPullRequestLookup.pipe(
          Effect.andThen(
            Effect.sync(() => {
              const merged = mergedPullRequests.find((entry) => entry.branch === input.branch);
              return merged === undefined
                ? null
                : { number: 7, state: "merged", headRef: input.branch, headSha: merged.headSha };
            }),
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
    setMergedPullRequest: (
      next:
        | { branch: string; headSha: string }
        | ReadonlyArray<{ branch: string; headSha: string }>
        | null,
    ) => {
      mergedPullRequests = next === null ? [] : "branch" in next ? [next] : [...next];
    },
    setDuringPullRequestLookup: (next: Effect.Effect<void>) => {
      duringPullRequestLookup = next;
    },
    setDuringScan: (next: Effect.Effect<void>) => {
      duringScan = next;
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
        { id: "placed-thread", worktreePath: placed, branch: "placed" },
        // Turn start recreates nothing for a thread with no branch.
        { id: "branchless-thread", worktreePath: placed },
        { id: "outside-thread", worktreePath: outside, branch: "outside" },
      ]);

      const recreatable = yield* service.remove({ path: placed });
      expect(recreatable.notes).toEqual([
        "Thread placed-thread still points at this path; it recreates the checkout from branch placed if it runs again.",
        "Thread branchless-thread still points at this path and cannot recreate its checkout.",
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

  it.effect(
    "a sweep whose removals outlast its budget returns what it removed and the count remaining",
    () =>
      Effect.gen(function* () {
        const { service, fs, addWorktree, setThreads } = yield* fixture;
        const paths = [yield* addWorktree("a"), yield* addWorktree("b"), yield* addWorktree("c")];
        setThreads(paths.map((path, i) => ({ id: "t" + i, worktreePath: path })));

        const first = yield* service.cleanup({ dryRun: false });
        expect(first.removed).toHaveLength(2);
        expect(first.remaining).toBe(1);
        expect(yield* service.cleanup({ dryRun: true })).toMatchObject({ remaining: 0 });
        const second = yield* service.cleanup({ dryRun: false });
        expect(second.removed).toHaveLength(1);
        expect(second.remaining).toBe(0);
        for (const path of paths) expect(yield* fs.exists(path)).toBe(false);
      }).pipe(
        // Each removal takes 40 s of a 60 s budget, as on a host with large checkouts.
        Effect.updateService(GitVcsDriver.GitVcsDriver, (git) => ({
          ...git,
          removeWorktree: (input) =>
            git.removeWorktree(input).pipe(Effect.tap(() => TestClock.adjust("40 seconds"))),
        })),
        Effect.provide(testLayer),
        Effect.scoped,
      ),
  );

  it.effect(
    "a sweep whose checks are slow returns inside the remote bound, one removal at a time",
    () =>
      Effect.gen(function* () {
        const {
          service,
          fs,
          run,
          addWorktree,
          setThreads,
          setMergedPullRequest,
          setDuringPullRequestLookup,
        } = yield* fixture;
        // Each pull request lookup takes 40 s; a sweep checks a worktree once, then again to remove it.
        setDuringPullRequestLookup(TestClock.adjust("40 seconds"));
        const merged = [];
        for (const branch of ["a", "b", "c"]) {
          const path = yield* addWorktree(branch);
          yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
          const headSha = (yield* run(path, ["rev-parse", "HEAD"])).stdout.trim();
          merged.push({ branch, path, headSha });
        }
        setMergedPullRequest(merged);
        setThreads(merged.map(({ path }, i) => ({ id: "t" + i, worktreePath: path })));

        const sweeps = [];
        for (const _ of merged) {
          const startedMs = yield* Clock.currentTimeMillis;
          const sweep = yield* service.cleanup({ dryRun: false });
          const tookMs = (yield* Clock.currentTimeMillis) - startedMs;
          sweeps.push([sweep.removed.length, sweep.kept.length, sweep.remaining, tookMs]);
        }
        // Remote callers give up at 120 s (HostThreadsMcpService REMOTE_TIMEOUT_MS).
        expect(sweeps).toEqual([
          [1, 0, 2, 80_000],
          [1, 0, 1, 80_000],
          [1, 0, 0, 80_000],
        ]);
        for (const { path } of merged) expect(yield* fs.exists(path)).toBe(false);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("slow kept worktrees rotate behind unchecked worktrees within the sweep budget", () =>
    Effect.gen(function* () {
      const { service, fs, run, addWorktree, setThreads, setDuringPullRequestLookup } =
        yield* fixture;
      const kept = [];
      for (const branch of ["a", "b", "c"]) {
        const path = yield* addWorktree(branch);
        yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
        kept.push(path);
      }
      const removable = yield* addWorktree("d");
      setThreads([...kept, removable].map((path, i) => ({ id: "t" + i, worktreePath: path })));
      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));

      const start = yield* Clock.currentTimeMillis;
      const first = yield* service.cleanup({ dryRun: false });
      expect((yield* Clock.currentTimeMillis) - start).toBe(80_000);
      expect(first.removed).toHaveLength(0);
      expect(first.remaining).toBeGreaterThan(0);
      let removed = false;
      for (let i = 0; i < 3; i++) {
        const result = yield* service.cleanup({ dryRun: false });
        removed ||= result.removed.some((entry) => entry.path === removable);
      }
      expect(removed).toBe(true);
      expect(yield* fs.exists(removable)).toBe(false);
      for (const path of kept) expect(yield* fs.exists(path)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("repeated sweeps reach remaining 0 when slow kept worktrees outlast one budget", () =>
    Effect.gen(function* () {
      const { service, run, addWorktree, setThreads, setDuringPullRequestLookup } = yield* fixture;
      const kept = [];
      for (const branch of ["a", "b", "c", "d"]) {
        const path = yield* addWorktree(branch);
        yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
        kept.push(path);
      }
      setThreads(kept.map((path, i) => ({ id: "t" + i, worktreePath: path })));
      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));

      const remaining = [];
      for (let i = 0; i < 2; i++)
        remaining.push((yield* service.cleanup({ dryRun: false })).remaining);
      expect(remaining).toEqual([2, 0]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("a sweep whose project scan outlasts the budget still checks and removes one", () =>
    Effect.gen(function* () {
      const { service, fs, addWorktree, setDuringScan } = yield* fixture;
      const first = yield* addWorktree("a");
      const second = yield* addWorktree("b");
      setDuringScan(TestClock.adjust("70 seconds"));

      const result = yield* service.cleanup({ dryRun: false });
      expect(result.removed).toHaveLength(1);
      expect(result.remaining).toBe(1);
      expect((yield* fs.exists(first)) && (yield* fs.exists(second))).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("overlapping removing sweeps of one scope run one at a time within the budget", () =>
    Effect.gen(function* () {
      const { service, run, addWorktree, setThreads, setDuringPullRequestLookup } = yield* fixture;
      const kept = [];
      for (const branch of ["a", "b"]) {
        const path = yield* addWorktree(branch);
        yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
        kept.push(path);
      }
      setThreads(kept.map((path, i) => ({ id: "t" + i, worktreePath: path })));
      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));

      const start = yield* Clock.currentTimeMillis;
      const sweeps = yield* Effect.all(
        [service.cleanup({ dryRun: false }), service.cleanup({ dryRun: false })],
        { concurrency: "unbounded" },
      );
      // The second waits for the first, then is past its own budget, so it checks nothing and
      // counts both as remaining in the round the first one closed.
      expect(sweeps.map((sweep) => [sweep.kept.length, sweep.remaining]).toSorted()).toEqual([
        [0, 2],
        [2, 0],
      ]);
      expect((yield* Clock.currentTimeMillis) - start).toBe(80_000);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("a removing sweep that waited past its budget answers without scanning again", () =>
    Effect.gen(function* () {
      const { service, run, addWorktree, setThreads, setDuringPullRequestLookup, setDuringScan } =
        yield* fixture;
      const kept = [];
      for (const branch of ["a", "b"]) {
        const path = yield* addWorktree(branch);
        yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
        kept.push(path);
      }
      setThreads(kept.map((path, i) => ({ id: "t" + i, worktreePath: path })));
      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));
      let scans = 0;
      setDuringScan(Effect.sync(() => void scans++));

      // The first holds the scope for 80 s; the second gets its turn 20 s past its own budget.
      const sweeps = yield* Effect.all(
        [service.cleanup({ dryRun: false }), service.cleanup({ dryRun: false })],
        { concurrency: "unbounded" },
      );
      expect(scans).toBe(1);
      expect(
        sweeps.map((sweep) => [sweep.removed.length, sweep.kept.length, sweep.remaining]),
      ).toEqual([
        [0, 2, 0],
        [0, 0, 2],
      ]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("removing sweeps of one scope past the waiting limit are refused at once", () =>
    Effect.gen(function* () {
      const { service, run, addWorktree, setThreads, setDuringPullRequestLookup } = yield* fixture;
      const path = yield* addWorktree("a");
      yield* run(path, ["commit", "--allow-empty", "-m", "work on a"]);
      setThreads([{ id: "t0", worktreePath: path }]);
      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));

      const sweeps = yield* Effect.all(
        Array.from({ length: 5 }, () => Effect.result(service.cleanup({ dryRun: false }))),
        { concurrency: "unbounded" },
      );
      expect(sweeps.map((sweep) => sweep._tag)).toEqual([
        "Success",
        "Success",
        "Success",
        "Success",
        "Failure",
      ]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("sweeps of a repo and of all repos keep separate rounds", () =>
    Effect.gen(function* () {
      const { service, repo, run, addWorktree, setThreads, setDuringPullRequestLookup } =
        yield* fixture;
      const kept = [];
      for (const branch of ["a", "b", "c", "d"]) {
        const path = yield* addWorktree(branch);
        yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
        kept.push(path);
      }
      setThreads(kept.map((path, i) => ({ id: "t" + i, worktreePath: path })));
      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));

      // Each sweep checks two of the four within its budget. A shared round would let the scoped
      // sweep finish the all-repos round early and send the next all-repos sweep back to the start.
      const remaining = [];
      for (const scope of [{}, { repo }, {}, { repo }])
        remaining.push((yield* service.cleanup({ ...scope, dryRun: false })).remaining);
      expect(remaining).toEqual([2, 2, 0, 0]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("a worktree whose check was interrupted still counts in remaining", () =>
    Effect.gen(function* () {
      const { service, run, addWorktree, setThreads, setDuringPullRequestLookup } = yield* fixture;
      const kept = [];
      for (const branch of ["a", "b", "c", "d"]) {
        const path = yield* addWorktree(branch);
        yield* run(path, ["commit", "--allow-empty", "-m", "work on " + branch]);
        kept.push(path);
      }
      setThreads(kept.map((path, i) => ({ id: "t" + i, worktreePath: path })));
      setDuringPullRequestLookup(Effect.interrupt);
      const interrupted = yield* Effect.exit(service.cleanup({ dryRun: false }));
      expect(interrupted._tag).toBe("Failure");

      setDuringPullRequestLookup(TestClock.adjust("40 seconds"));
      const next = yield* service.cleanup({ dryRun: false });
      expect(next.kept).toHaveLength(2);
      expect(next.remaining).toBe(2);
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
            Effect.orDie,
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

  it.live(
    "storage cleanup removes a clean, pushed checkout only archived threads used, and prunes nothing else",
    () =>
      Effect.gen(function* () {
        const { service, fs, run, repo, addWorktree, commit, setThreads } = yield* fixture;
        const path = yield* addWorktree("abandoned");
        const head = yield* commit(path);
        yield* run(path, ["push", "origin", "abandoned"]);
        // Deleted by hand: git still lists it, and this removal must leave that record alone.
        const gone = yield* addWorktree("gone");
        yield* fs.remove(gone, { recursive: true });
        setThreads([{ id: "t1", worktreePath: path, archived: true }]);

        const result = yield* service.removeAbandoned({
          path,
          head,
          branch: "abandoned",
          verify: Effect.succeed(null),
        });
        expect(result).toEqual({ removed: true });
        expect(yield* fs.exists(path)).toBe(false);
        expect((yield* run(repo, ["worktree", "list", "--porcelain"])).stdout).toContain(gone);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("a thread working in a folder inside a checkout keeps the whole checkout", () =>
    Effect.gen(function* () {
      const { service, fs, run, addWorktree, commit, setThreads } = yield* fixture;
      const path = yield* addWorktree("monorepo");
      const head = yield* commit(path);
      yield* run(path, ["push", "origin", "monorepo"]);
      const pkg = path + "/packages/app";
      yield* fs.makeDirectory(pkg, { recursive: true });
      // Idle, unarchived, no provider session: only its binding says it uses the checkout.
      setThreads([{ id: "t1", worktreePath: pkg, status: "completed" }]);

      const listed = (yield* service.inventory({})).worktrees.find((entry) => entry.path === path);
      expect(listed?.threads).toEqual([expect.objectContaining({ threadId: "t1" })]);
      expect(
        yield* service.removeAbandoned({
          path,
          head,
          branch: "monorepo",
          verify: Effect.succeed(null),
        }),
      ).toEqual({ removed: false, reason: "thread t1 (Thread t1) uses it" });
      expect(yield* fs.exists(pkg)).toBe(true);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live(
    "storage cleanup keeps checkouts with work, a live thread, a changed head, or a failed check",
    () =>
      Effect.gen(function* () {
        const { service, fs, run, addWorktree, commit, setThreads } = yield* fixture;
        const dirty = yield* addWorktree("dirty");
        yield* fs.writeFileString(dirty + "/scratch.txt", "draft\n");
        // remove() accepts commits another local branch holds; the storage cleanup does not.
        const local = yield* addWorktree("local-only");
        const localHead = yield* commit(local);
        yield* run(local, ["branch", "backup"]);
        const live = yield* addWorktree("live");
        yield* run(live, ["push", "origin", "live"]);
        const pushed = yield* addWorktree("pushed");
        yield* run(pushed, ["push", "origin", "pushed"]);
        const pushedHead = (yield* run(pushed, ["rev-parse", "HEAD"])).stdout.trim();
        setThreads([{ id: "t1", worktreePath: live, status: "completed" }]);
        const headOf = (path: string) =>
          run(path, ["rev-parse", "HEAD"]).pipe(Effect.map((result) => result.stdout.trim()));

        const keep = (
          path: string,
          branch: string,
          head: string,
          verify = Effect.succeed<string | null>(null),
        ) => service.removeAbandoned({ path, head, branch, verify });
        expect(yield* keep(dirty, "dirty", yield* headOf(dirty))).toEqual({
          removed: false,
          reason: "it has 1 file with uncommitted changes",
        });
        expect(yield* keep(local, "local-only", localHead)).toEqual({
          removed: false,
          reason: "it has 1 commit on no remote",
        });
        expect(yield* keep(live, "live", yield* headOf(live))).toEqual({
          removed: false,
          reason: "thread t1 (Thread t1) uses it",
        });
        expect(yield* keep(pushed, "pushed", "0".repeat(40))).toEqual({
          removed: false,
          reason: "its branch or commit changed since it was reviewed",
        });
        expect(
          yield* keep(pushed, "pushed", pushedHead, Effect.succeed("a process is running in it")),
        ).toEqual({
          removed: false,
          reason: "a process is running in it",
        });
        for (const path of [dirty, local, live, pushed]) expect(yield* fs.exists(path)).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
});

describe("WorktreeSweepRounds", () => {
  it.effect(
    "bound: many repo scopes keep at most the cap of idle rounds, evicting the least recently used",
    () =>
      Effect.sync(() => {
        const roundOf = makeSweepRounds(2);
        const first = roundOf("/repo/a");
        const second = roundOf("/repo/b");
        expect(roundOf("/repo/a")).toBe(first);
        for (let i = 0; i < 100; i++) roundOf("/repo/other-" + i);
        expect(roundOf("/repo/a")).not.toBe(first);
        expect(roundOf("/repo/b")).not.toBe(second);
      }),
  );

  it.effect("bound: a round with a sweep running or waiting is never evicted", () =>
    Effect.sync(() => {
      const roundOf = makeSweepRounds(2);
      const busy = roundOf("/repo/a");
      busy.removingSweeps = 1;
      for (let i = 0; i < 100; i++) roundOf("/repo/other-" + i);
      expect(roundOf("/repo/a")).toBe(busy);
    }),
  );
});
