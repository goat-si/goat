// @effect-diagnostics nodeBuiltinImport:off - holds a file open from a child process the test owns.
import * as NodeChildProcess from "node:child_process";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { LEGACY_WORKTREE_RULES, cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";
import { DAY_MS, at, shell } from "./storageCleanup.testFixtures.ts";

const withSnapshots = {
  ...DEFAULT_SERVER_SETTINGS.storageCleanup,
  ...LEGACY_WORKTREE_RULES,
  worktreeAfterDays: 8,
  worktreeSnapshotChanges: true,
};

describe("snapshot before removal", () => {
  it.live("removes a worktree with local changes only after saving them in a snapshot ref", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command } = yield* cleanupFixture(withSnapshots);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "edited\n");
        yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
        yield* fs.writeFileString(`${worktree}/staged.txt`, "staged\n");
        yield* command(worktree, ["add", "staged.txt"]);
        yield* fs.writeFileString(`${worktree}/staged.txt`, "staged, then edited\n");

        const report = yield* service.runNow;
        const entry = report.entries.find((candidate) => candidate.kind === "worktree");
        expect(entry).toMatchObject({ outcome: "removed", path: worktree });
        expect(yield* fs.exists(worktree)).toBe(false);
        const ref = entry?.snapshotRef ?? "";
        expect(ref).toMatch(/^refs\/goat\/snapshots\/thread-1\//);
        const show = (spec: string) =>
          command(repo, ["show", spec]).pipe(Effect.map((result) => result.stdout));
        expect(yield* show(`${ref}:tracked.txt`)).toBe("edited\n");
        expect(yield* show(`${ref}:notes.txt`)).toBe("untracked\n");
        expect(yield* show(`${ref}:staged.txt`)).toBe("staged, then edited\n");
        expect(yield* show(`${ref}^2:staged.txt`)).toBe("staged\n");
      }),
    ),
  );

  it.live("keeps the worktree when its state cannot be snapshotted", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, command } = yield* cleanupFixture(withSnapshots);
        yield* fs.writeFileString(`${worktree}/tracked.txt`, "edited\n");
        const gitDir = (yield* command(worktree, [
          "rev-parse",
          "--absolute-git-dir",
        ])).stdout.trim();
        const head = (yield* command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
        yield* fs.writeFileString(`${gitDir}/MERGE_HEAD`, `${head}\n`);

        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.kind === "worktree")).toMatchObject({
          outcome: "kept",
          reason: expect.stringContaining("Snapshot failed"),
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );

  it.live("keeps the worktree while another process holds a file in it open", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree } = yield* cleanupFixture(withSnapshots);
        yield* fs.writeFileString(`${worktree}/notes.txt`, "untracked\n");
        const holder = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeChildProcess.spawn(
              process.execPath,
              [
                "-e",
                "require('fs').openSync(process.argv[1], 'r'); setInterval(() => {}, 1000)",
                `${worktree}/notes.txt`,
              ],
              { stdio: "ignore" },
            ),
          ),
          (child) => Effect.sync(() => child.kill()),
        );
        expect(holder.pid).toBeTypeOf("number");
        yield* Effect.promise(() => new Promise((resolve) => holder.once("spawn", resolve)));

        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.kind === "worktree")).toMatchObject({
          outcome: "kept",
          reason: expect.stringMatching(
            /process is using this worktree|couldn't check which processes/,
          ),
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
});

describe("default retention rules", () => {
  it.live("keeps a pinned thread's worktree under every age and count rule", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture({
          ...withSnapshots,
          worktreeOnArchive: true,
          worktreeKeepRecent: 1,
        });
        setThreads([
          shell({
            branch: "feature",
            worktreePath: worktree,
            pinnedAt: at(-DAY_MS),
            archivedAt: at(-DAY_MS),
          }),
        ]);
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.kind === "worktree")).toMatchObject({
          outcome: "kept",
          reason: "Thread is pinned",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );

  it.live("removes an archived thread's worktree regardless of age", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setThreads } = yield* cleanupFixture({
          ...withSnapshots,
          worktreeAfterDays: null,
          worktreeOnArchive: true,
        });
        setThreads([
          shell({
            branch: "feature",
            worktreePath: worktree,
            createdAt: at(-DAY_MS),
            archivedAt: at(-DAY_MS),
          }),
        ]);
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.kind === "worktree")).toMatchObject({
          outcome: "removed",
          reason: "Thread was archived",
        });
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );

  it.live("removes worktrees beyond the most recently used count", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, path, config, setThreads } = yield* cleanupFixture({
          ...withSnapshots,
          worktreeAfterDays: null,
          worktreeKeepRecent: 1,
        });
        setThreads([
          shell({ branch: "feature", worktreePath: worktree, createdAt: at(-2 * DAY_MS) }),
          shell({
            id: "thread-2" as never,
            lineage: {
              rootThreadId: "thread-2" as never,
              parentThreadId: null,
              relationshipToParent: null,
            },
            branch: "newer",
            worktreePath: path.join(config.worktreesDir, "newer"),
            createdAt: at(-DAY_MS),
          }),
        ]);
        const report = yield* service.runNow;
        expect(report.entries.find((entry) => entry.path === worktree)).toMatchObject({
          outcome: "removed",
          reason: "Beyond the most recent 1 worktrees",
        });
        expect(yield* fs.exists(worktree)).toBe(false);
      }),
    ),
  );
});
