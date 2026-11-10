import type { StorageCleanupReportEntry, WorktreeCleanupPreview } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { makeWorktreeCleanupRun } from "./storageCleanupRun.ts";
import { WorktreeCleanupPreviewState } from "./worktreeSnapshots/WorktreeCleanupPreviewState.ts";
import { WorktreeSnapshotStore } from "./worktreeSnapshots/WorktreeSnapshotStore.ts";

const preview: WorktreeCleanupPreview = {
  id: "preview-1",
  plannedCount: 1,
  startedAt: "2026-06-10T12:00:00.000Z",
  seenAt: null,
  activatesAt: null,
  requiresConfirmation: false,
};
const entry = (planned: boolean): StorageCleanupReportEntry => ({
  kind: "worktree",
  outcome: "kept",
  reason: planned ? "Will be cleaned up once cleanup starts: thread was archived" : "Open terminal",
  path: "/worktrees/feature",
  projectPath: "/repo",
  threadId: null,
  threadTitle: null,
  bytes: null,
  files: null,
  ...(planned ? { planned: true } : {}),
});

const setup = (gate: ReadonlyArray<{ readonly apply: boolean }>) => {
  const calls = {
    evaluate: [] as number[],
    expire: [] as number[],
    purge: 0,
    passes: [] as boolean[],
  };
  let next = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(WorktreeCleanupPreviewState, {
      evaluate: (input) =>
        Effect.sync(() => {
          calls.evaluate.push(input.plannedCount);
          const apply = gate[Math.min(next++, gate.length - 1)]?.apply ?? false;
          return { apply, preview: apply ? null : preview };
        }),
      respond: () => Effect.void,
    }),
    Layer.succeed(WorktreeSnapshotStore, {
      capture: () => Effect.die("unused"),
      latestForThread: () => Effect.succeed(null),
      markRestored: () => Effect.void,
      deleteForThread: () => Effect.succeed(0),
      purgeDeletedThreads: () => Effect.sync(() => void calls.purge++).pipe(Effect.as(0)),
      expire: (_now, days) => Effect.sync(() => void calls.expire.push(days)).pipe(Effect.as(0)),
    }),
    Layer.succeed(SqlClient.SqlClient, (() =>
      Effect.succeed([])) as unknown as SqlClient.SqlClient),
  );
  const clean = (dryRun: boolean, into: StorageCleanupReportEntry[]) =>
    Effect.sync(() => {
      calls.passes.push(dryRun);
      into.push(entry(dryRun), entry(false));
      return { waiting: false, kept: [] };
    });
  return { calls, layer, clean };
};

describe("worktree cleanup preview gate", () => {
  it.effect(
    "removes on the first sweep, with no dry pass or preview, when the preview is off",
    () => {
      const { calls, layer, clean } = setup([{ apply: false }]);
      return Effect.gen(function* () {
        const run = yield* makeWorktreeCleanupRun(Effect.succeed(true));
        const entries: StorageCleanupReportEntry[] = [];
        const result = yield* run({ nowMs: 0, snapshotDays: 30, preview: false, entries, clean });
        expect(calls.passes).toEqual([false]);
        expect(calls.evaluate).toEqual([]);
        expect(result.preview).toBeNull();
        expect(calls.expire).toEqual([30]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "removes nothing until the preview is approved, and reports what it would remove",
    () => {
      const { calls, layer, clean } = setup([{ apply: false }]);
      return Effect.gen(function* () {
        const run = yield* makeWorktreeCleanupRun(Effect.succeed(false));
        const entries: StorageCleanupReportEntry[] = [];
        const result = yield* run({ nowMs: 0, snapshotDays: 30, preview: true, entries, clean });
        expect(calls.passes).toEqual([true]);
        expect(calls.evaluate).toEqual([1]);
        expect(result.preview).toEqual(preview);
        expect(entries.filter((candidate) => candidate.planned === true)).toHaveLength(1);
        expect(calls.expire).toEqual([30]);
        expect(calls.purge).toBe(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("runs the real pass once approved and skips the dry pass afterwards", () => {
    const { calls, layer, clean } = setup([{ apply: true }]);
    return Effect.gen(function* () {
      const run = yield* makeWorktreeCleanupRun(Effect.succeed(false));
      const first: StorageCleanupReportEntry[] = [];
      expect(
        (yield* run({ nowMs: 0, snapshotDays: null, preview: true, entries: first, clean }))
          .preview,
      ).toBeNull();
      expect(first.some((candidate) => candidate.planned === true)).toBe(false);
      yield* run({ nowMs: 1, snapshotDays: null, preview: true, entries: [], clean });
      expect(calls.passes).toEqual([true, false, false]);
      expect(calls.evaluate).toEqual([1]);
      expect(calls.expire).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts no preview while nothing would be removed", () => {
    const { calls, layer } = setup([{ apply: false }]);
    return Effect.gen(function* () {
      const run = yield* makeWorktreeCleanupRun(Effect.succeed(true));
      const result = yield* run({
        nowMs: 0,
        snapshotDays: null,
        preview: true,
        entries: [],
        clean: (_dryRun, into) =>
          Effect.sync(() => (into.push(entry(false)), { waiting: false, kept: [] })),
      });
      expect(result.preview).toBeNull();
      expect(calls.evaluate).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
