import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { rankWorktrees, retentionReason } from "./storageCleanupRetention.ts";

const rules = { worktreeOnArchive: true, worktreeKeepRecent: 15 };

describe("worktree retention decisions", () => {
  it.effect("ranks each managed worktree once by its most recent owner", () =>
    Effect.sync(() => {
      const worktrees = Array.from({ length: 17 }, (_, index) => ({
        path: `/managed/${index}`,
        activityAt: index,
      }));
      const ranks = rankWorktrees([...worktrees, { path: "/managed/0", activityAt: 100 }]);
      expect(ranks.get("/managed/0")).toBe(0);
      expect(ranks.get("/managed/2")).toBe(15);
      expect(ranks.get("/managed/1")).toBe(16);
    }),
  );
  it.effect("archive and recent rules are alternatives and pins protect live threads", () =>
    Effect.sync(() => {
      expect(
        retentionReason({ rules, archived: true, pinned: false, deleted: false, rank: 0 }),
      ).toBe("thread was archived");
      expect(
        retentionReason({ rules, archived: false, pinned: false, deleted: false, rank: 15 }),
      ).toBe("beyond the most recent 15 worktrees");
      expect(
        retentionReason({ rules, archived: true, pinned: true, deleted: false, rank: 16 }),
      ).toBeNull();
      expect(
        retentionReason({ rules, archived: true, pinned: true, deleted: true, rank: 16 }),
      ).toBeNull();
    }),
  );
});
