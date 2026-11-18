import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ServerConfig from "./config.ts";
import { shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

// Restore recreates only <worktrees folder>/<repository>/<name>; anything cleaned elsewhere stays lost.
const cleanAt = (segments: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const fixture = yield* cleanupFixture();
    const worktreePath = path.join(config.worktreesDir, ...segments);
    yield* fixture.command(fixture.repo, ["worktree", "add", "-b", "located", worktreePath]);
    fixture.setThreads([shell({ branch: "located", worktreePath })]);
    fixture.setStoredWorktreePaths([worktreePath]);
    const report = yield* fixture.service.runNow;
    return {
      entry: report.entries.find((entry) => entry.path === worktreePath),
      present: yield* fixture.fs.exists(worktreePath),
    };
  });

it.live.each([
  { at: "<name>", segments: ["located"] },
  { at: "a/b/<name>", segments: ["a", "b", "located"] },
])(
  "keeps a worktree at <worktrees folder>/$at, where restore could not recreate it",
  ({ segments }) =>
    runCleanupTest(
      Effect.gen(function* () {
        const { entry, present } = yield* cleanAt(segments);
        expect(entry).toMatchObject({
          outcome: "kept",
          reason:
            "GOAT can only restore worktrees at <worktrees folder>/<repository>/<name>, and this one is elsewhere",
        });
        expect(present).toBe(true);
      }),
    ),
);

it.live("still removes a worktree at <worktrees folder>/<repository>/<name>", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const { entry, present } = yield* cleanAt(["repo", "located"]);
      expect(entry).toMatchObject({ outcome: "removed" });
      expect(present).toBe(false);
    }),
  ),
);
