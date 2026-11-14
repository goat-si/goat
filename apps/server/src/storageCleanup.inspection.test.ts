import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live("skips a stored worktree path whose parent is a regular file", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const legacyRoot = `${fixture.config.worktreesDir}/legacy-root`;
      yield* fixture.fs.writeFileString(legacyRoot, "");
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: `${legacyRoot}/stored-workspace` }),
      ]);
      const report = yield* fixture.service.runNow;
      expect(report.entries).toEqual([]);
      expect(report.counts).toEqual({ removed: 0, kept: 0, failed: 0 });
    }),
  ),
);

it.live.each([
  ["uncommitted-changes", "untracked", "Local changes exceed the inspection limit"],
  ["any-local-files", "ignored", "Ignored files exceed the inspection limit"],
] as const)(
  "keeps a worktree when its %s %s listing exceeds the inspection limit",
  ([policy, kind, reason]) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { service, fs, worktree, setPolicy } = yield* cleanupFixture();
        setPolicy(policy);
        const files = Array.from({ length: 3000 }, (_, i) =>
          kind === "untracked"
            ? `${worktree}/many/untracked-file-with-a-long-name-${i}.txt`
            : `${worktree}/many/ignored-directory-with-a-long-name-${i}/.env`,
        );
        yield* fs.makeDirectory(`${worktree}/many`);
        yield* Effect.forEach(
          files,
          (file) =>
            Effect.gen(function* () {
              if (kind === "ignored") yield* fs.makeDirectory(file.slice(0, -"/.env".length));
              yield* fs.writeFileString(file, "local\n");
            }),
          { concurrency: 64, discard: true },
        );
        expect((yield* service.runNow).entries[0]).toMatchObject({ outcome: "kept", reason });
        expect(yield* fs.exists(files[0]!)).toBe(true);
      }),
    ),
);
