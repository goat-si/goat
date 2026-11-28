import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@goat/contracts";
import { DAY_MS, at, shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

describe("broken cleanup fetch", () => {
  it.live("fetches a failing default branch once per sweep and names the broken local ref", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, repo, worktree, command, setThreads, setStoredWorktreePaths } =
          yield* cleanupFixture({
            ...DEFAULT_SERVER_SETTINGS.storageCleanup,
            worktreeUnchanged: true,
          });
        const second = `${worktree}-2`;
        yield* command(repo, ["worktree", "add", "-b", "feature-2", second]);
        setStoredWorktreePaths([worktree, second]);
        setThreads([
          shell({ branch: "feature", worktreePath: worktree, archivedAt: at(-DAY_MS) }),
          shell({
            id: ThreadId.make("thread-2"),
            branch: "feature-2",
            worktreePath: second,
            archivedAt: at(-DAY_MS),
          }),
        ]);
        const remote = yield* fs.makeTempDirectoryScoped({ prefix: "cleanup-remote-" });
        yield* command(remote, ["init", "--bare", "-b", "main"]);
        yield* command(repo, ["remote", "add", "origin", remote]);
        yield* command(repo, ["push", "origin", "main"]);
        yield* command(repo, ["remote", "set-head", "origin", "main"]);
        yield* command(repo, ["commit", "--allow-empty", "-m", "remote only"]);
        yield* command(repo, ["push", "origin", "main"]);
        yield* command(repo, ["reset", "--hard", "HEAD~1"]);
        yield* command(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        const trackingRef = yield* fs.readFileString(`${repo}/.git/refs/remotes/origin/main`);
        yield* fs.writeFileString(`${repo}/.git/refs/remotes/origin/main 2`, trackingRef);
        const fetchLog = `${remote}/fetches.log`;
        const uploadPack = `${remote}/upload-pack.sh`;
        yield* fs.writeFileString(
          uploadPack,
          `#!/bin/sh\necho fetch >> '${fetchLog}'\nexec git-upload-pack "$@"\n`,
        );
        yield* fs.chmod(uploadPack, 0o755);
        yield* command(repo, ["config", "remote.origin.uploadpack", uploadPack]);

        const report = yield* service.runNow;
        expect((yield* fs.readFileString(fetchLog)).trim().split("\n")).toHaveLength(1);
        expect(report.entries).toHaveLength(2);
        for (const entry of report.entries) {
          expect(entry.outcome).not.toBe("removed");
          expect(entry.reason).toContain("broken local ref");
        }
        expect(yield* fs.exists(worktree)).toBe(true);
        expect(yield* fs.exists(second)).toBe(true);
      }),
    ),
  );
});
