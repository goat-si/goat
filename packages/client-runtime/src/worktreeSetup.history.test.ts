import { ThreadId, type WorktreeSetupSnapshot } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { resolveVisibleWorktreeSetup } from "./worktreeSetup.ts";

it("does not revive a completed setup when a later run has not started", () => {
  const done: WorktreeSetupSnapshot = {
    threadId: ThreadId.make("setup-thread"),
    sequence: 1,
    phase: "done",
    startedAt: "2026-09-17T00:00:00.000Z",
    endedAt: "2026-09-17T00:01:00.000Z",
    branch: "feature",
    baseRef: "main",
    worktreePath: null,
    setupScript: null,
    stages: [],
    error: null,
  };
  expect(
    resolveVisibleWorktreeSetup({
      live: done,
      recorded: null,
      turnStarted: false,
      followUpSent: false,
      runs: [{ startedAt: DateTime.makeUnsafe("2026-09-17T00:01:00.000Z") }, { startedAt: null }],
    }),
  ).toBeNull();
});
