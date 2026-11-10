import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { LEGACY_WORKTREE_RULES, cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

// The testkit's preview state dies when consulted, so these runs also prove the preview stays out of the way.
describe("worktree cleanup without the opt-in preview", () => {
  it.live("keeps a worktree when the preview is turned on while its removal is in flight", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        fixture.setOpenSessionCwd(fixture.worktree);
        fixture.setSessionLive(false);
        fixture.setOnLiveCheck(
          Effect.sync(() =>
            fixture.setSettings({
              storageCleanup: {
                ...DEFAULT_SERVER_SETTINGS.storageCleanup,
                ...LEGACY_WORKTREE_RULES,
                worktreeAfterDays: 8,
                worktreeOnDelete: true,
                worktreeCleanupPreview: true,
              },
            }),
          ),
        );
        const report = yield* fixture.service.runNow;
        expect(report.entries.find((entry) => entry.path === fixture.worktree)).toMatchObject({
          outcome: "kept",
          reason: "settings changed since check",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );

  it.live("ignores an answer to a preview left from when it was on", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* cleanupFixture();
        const latest = yield* fixture.service.respondPreview({
          previewId: "preview-from-before",
          response: "confirm",
        });
        expect(latest).toBeNull();
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
  );
});
