import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, GitManagerError, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";

import { DAY_MS, at, shell } from "./storageCleanup.testFixtures.ts";
import { LEGACY_WORKTREE_RULES, cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

// Neither commit rule is on, so only the time and retention rules make a worktree eligible.
const BASE = {
  ...DEFAULT_SERVER_SETTINGS.storageCleanup,
  ...LEGACY_WORKTREE_RULES,
  worktreeUnchanged: false,
  worktreeOnMerge: false,
};
const RULES = {
  settled: { rules: { worktreeSettledAfterDays: 0 }, thread: { settledAt: at(-DAY_MS) } },
  inactive: { rules: { worktreeAfterDays: 1 }, thread: {} },
  archived: { rules: { worktreeOnArchive: true }, thread: { archivedAt: at(-DAY_MS) } },
} as const;
const SETTLED = { ...BASE, ...RULES.settled.rules };

type Fixture = Effect.Success<ReturnType<typeof cleanupFixture>>;

const withOrigin = (fixture: Fixture) =>
  Effect.gen(function* () {
    const origin = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-origin-" });
    yield* fixture.command(origin, ["init", "--bare", "-b", "main"]);
    yield* fixture.command(fixture.repo, ["remote", "add", "origin", origin]);
    yield* fixture.command(fixture.repo, ["push", "origin", "main"]);
    yield* fixture.command(fixture.repo, ["fetch", "origin"]);
    return origin;
  });

const commitInWorktree = (fixture: Fixture, worktree = fixture.worktree) =>
  Effect.gen(function* () {
    yield* fixture.fs.writeFileString(`${worktree}/tracked.txt`, "unshipped work\n");
    yield* fixture.command(worktree, ["commit", "-am", "unshipped work"]);
    return (yield* fixture.command(worktree, ["rev-parse", "HEAD"])).stdout.trim();
  });

const pullRequest = (state: "open" | "closed" | "merged", headSha: string) => ({
  number: 12,
  title: "Feature",
  url: "https://example.test/pull/12",
  baseRef: "main",
  headRef: "feature",
  state,
  repositoryKey: null,
  updatedAt: null,
  headSha,
});

describe("automatic cleanup keeps unshipped commits", () => {
  it.live.each(Object.keys(RULES) as Array<keyof typeof RULES>)(
    "keeps a clean worktree whose branch has local-only commits and no pull request (%s rule)",
    (rule) =>
      runCleanupTest(
        Effect.gen(function* () {
          const fixture = yield* cleanupFixture({ ...BASE, ...RULES[rule].rules });
          yield* withOrigin(fixture);
          yield* commitInWorktree(fixture);
          fixture.setThreads([
            shell({ branch: "feature", worktreePath: fixture.worktree, ...RULES[rule].thread }),
          ]);
          const report = yield* fixture.service.runNow;
          expect(report.entries[0]).toMatchObject({
            outcome: "kept",
            reason:
              "Unshipped commits (1 not in origin/main, no merged pull request). Merge them to let cleanup remove this worktree",
          });
          expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        }),
      ),
  );

  it.live("keeps local-only commits in a repository without a remote", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        yield* commitInWorktree(fixture);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason:
            "Unshipped commits (1 not on the project branch main). Merge them into main to let cleanup remove this worktree",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );

  it.live("keeps a pushed branch whose pull request is still open", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        yield* withOrigin(fixture);
        const head = yield* commitInWorktree(fixture);
        yield* fixture.command(fixture.repo, ["push", "origin", "feature"]);
        fixture.setPullRequest(Effect.succeed(pullRequest("open", head)));
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason:
            "Unshipped commits (1 not in origin/main, pull request #12 is open). Merge them to let cleanup remove this worktree",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );

  it.live("keeps the worktree when GOAT can't check for a merged pull request", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        yield* withOrigin(fixture);
        yield* commitInWorktree(fixture);
        fixture.setPullRequest(
          Effect.fail(
            new GitManagerError({
              operation: "branchPullRequest",
              cwd: "",
              detail: "rate limited",
            }),
          ),
        );
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason:
            "Unshipped commits (1 not in origin/main, couldn't check for a merged pull request). Merge them to let cleanup remove this worktree",
        });
      }),
    ),
  );

  // Regression guard: this already removed before the fix.
  it.live("removes a settled worktree whose commits reached origin/main", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        yield* withOrigin(fixture);
        yield* commitInWorktree(fixture);
        yield* fixture.command(fixture.repo, ["push", "origin", "feature:main"]);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]?.outcome).toBe("removed");
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );

  it.live("removes a settled worktree whose squash-merged pull request names its head", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        yield* withOrigin(fixture);
        const head = yield* commitInWorktree(fixture);
        fixture.setPullRequest(Effect.succeed(pullRequest("merged", head)));
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]?.outcome).toBe("removed");
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }),
    ),
  );

  it.live("keeps every worktree of a repository whose default branch can't be refreshed", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        const origin = yield* withOrigin(fixture);
        yield* commitInWorktree(fixture);
        // origin/main holds this head, but only as of the last fetch.
        yield* fixture.command(fixture.repo, ["push", "origin", "feature:main"]);
        yield* fixture.command(fixture.repo, ["fetch", "origin"]);
        const second = fixture.path.join(fixture.config.worktreesDir, "second");
        yield* fixture.command(fixture.repo, [
          "worktree",
          "add",
          "-b",
          "second",
          second,
          "feature",
        ]);
        yield* fixture.command(fixture.repo, ["remote", "set-url", "origin", origin + "-gone"]);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
          shell({
            id: ThreadId.make("thread-2"),
            branch: "second",
            worktreePath: second,
            settledAt: at(-DAY_MS),
          }),
        ]);
        const report = yield* fixture.service.runNow;
        const reason =
          "Couldn't refresh origin/main, so GOAT can't confirm this worktree's commits were shipped";
        expect(report.entries.filter((entry) => entry.kind === "worktree")).toMatchObject([
          { outcome: "kept", reason },
          { outcome: "kept", reason },
        ]);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
        expect(yield* fixture.fs.exists(second)).toBe(true);
      }),
    ),
  );

  it.live("keeps the worktree when the remote has no default branch", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture(SETTLED);
        const origin = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-origin-" });
        yield* fixture.command(origin, ["init", "--bare", "-b", "main"]);
        yield* fixture.command(fixture.repo, ["remote", "add", "origin", origin]);
        yield* commitInWorktree(fixture);
        fixture.setThreads([
          shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(-DAY_MS) }),
        ]);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason:
            "Default branch is unavailable, so GOAT can't confirm this worktree's commits were shipped",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
  it.live("keeps the worktree when the remote default is unavailable even if main exists", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command } = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          ...LEGACY_WORKTREE_RULES,
          worktreeUnchanged: true,
        });
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "trunk"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        // The remote HEAD names an unborn trunk; main exists but is not its default.
        yield* command(repo, ["push", "origin", "main"]);

        const report = yield* service.runNow;
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason:
            "Default branch is unavailable, so GOAT can't confirm this worktree's commits were shipped",
        });
        expect(yield* fs.exists(worktree)).toBe(true);
      }),
    ),
  );
});
