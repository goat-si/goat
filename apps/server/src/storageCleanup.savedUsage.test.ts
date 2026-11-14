import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { NOW_MS, at, shell } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, LEGACY_WORKTREE_RULES, runCleanupTest } from "./storageCleanup.testkit.ts";

it.effect("keeps saved usage data when removing a settled checkout", () =>
  runCleanupTest(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      fixture.setSettings({
        storageCleanup: {
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          ...LEGACY_WORKTREE_RULES,
          worktreeSettledAfterDays: 0,
        },
      });
      fixture.setThreads([
        shell({ branch: "feature", worktreePath: fixture.worktree, settledAt: at(0) }),
      ]);
      yield* fixture.fs.makeDirectory(fixture.config.stateDir, { recursive: true });
      const cachePath = `${fixture.config.stateDir}/${SCAN_CACHE_FILE_NAME}`;
      const savedUsage = JSON.stringify({ tokens: 12345, cost: 1.25 });
      yield* fixture.fs.writeFileString(cachePath, savedUsage);
      expect((yield* fixture.service.runNow).counts.removed).toBe(1);
      expect(yield* fixture.fs.readFileString(cachePath)).toBe(savedUsage);
    }),
  ),
);
