import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

it.live("treats a parenthesized branch as attached during cleanup", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      yield* fixture.command(fixture.worktree, ["switch", "-c", "(feature)"]);
      fixture.setThreads([shell({ branch: "(feature)", worktreePath: fixture.worktree })]);
      expect((yield* fixture.service.runNow).entries[0]).toMatchObject({ outcome: "removed" });
    }),
  ),
);
