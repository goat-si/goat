import { it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import { NOW_MS, DAY_MS, at, shell } from "./storageCleanup.testFixtures.ts";
import {
  cleanupFixture,
  cleanupTestLayer,
  pausedMeasurementFixture,
  runCleanupTest,
} from "./storageCleanup.testkit.ts";

it.effect("keeps a checkout two top-level threads store through a symlinked parent", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const fixture = yield* cleanupFixture({
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      worktreeSettledAfterDays: 8,
    });
    const linkedParent = `${yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-link-" })}/worktrees`;
    yield* fixture.fs.symlink(fixture.config.worktreesDir, linkedParent);
    const settled = { branch: "feature", settledAt: at(-20 * DAY_MS) };
    fixture.setThreads([
      shell({ ...settled, worktreePath: fixture.worktree }),
      shell({ ...settled, id: ThreadId.make("other"), worktreePath: `${linkedParent}/feature` }),
    ]);
    const report = yield* fixture.service.runNow;
    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: "kept", reason: "Shared by 2 threads" }),
    ]);
    expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
  }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
);

it.effect("keeps a checkout two top-level threads store in different case on Windows", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const fixture = yield* cleanupFixture({
      ...DEFAULT_SERVER_SETTINGS.storageCleanup,
      worktreeSettledAfterDays: 8,
    }).pipe(Effect.provideService(HostProcess.Platform, "win32"));
    const settled = { branch: "feature", settledAt: at(-20 * DAY_MS) };
    fixture.setThreads([
      shell({ ...settled, worktreePath: fixture.worktree }),
      shell({
        ...settled,
        id: ThreadId.make("other"),
        worktreePath: fixture.worktree.toUpperCase(),
      }),
    ]);
    const report = yield* fixture.service.runNow;
    expect(report.entries).toEqual([
      expect.objectContaining({ outcome: "kept", reason: "Shared by 2 threads" }),
    ]);
    expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
  }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
);

it.live("keeps a worktree for a live session in a missing folder under its stored alias", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* cleanupFixture();
      const linkedParent = `${yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-link-" })}/worktrees`;
      yield* fixture.fs.symlink(fixture.config.worktreesDir, linkedParent);
      fixture.setThreads([shell({ branch: "feature", worktreePath: `${linkedParent}/feature` })]);
      fixture.setOpenSessionCwd(`${linkedParent}/feature/removed-folder`);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        outcome: "kept",
        reason: "Provider session is still open",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }),
  ),
);

it.live.each(["before-check", "while-measuring"] as const)(
  "keeps a checkout when a missing project is under its alias (%s)",
  (timing) =>
    runCleanupTest(
      Effect.gen(function* () {
        const fixture = yield* pausedMeasurementFixture();
        const linkedParent = `${yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-link-" })}/worktrees`;
        yield* fixture.fs.symlink(fixture.config.worktreesDir, linkedParent);
        const worktree = `${linkedParent}/feature`;
        fixture.setThreads([shell({ branch: "feature", worktreePath: worktree })]);
        if (timing === "before-check")
          fixture.setProjectRoots([fixture.repo, `${worktree}/removed-checkout`]);
        const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
        if (timing === "while-measuring") {
          yield* Deferred.await(fixture.measuring);
          fixture.setProjectRoots([fixture.repo, `${worktree}/removed-checkout`]);
        }
        yield* Deferred.succeed(fixture.resume, undefined);
        const report = yield* Fiber.join(cleanup);
        expect(report.entries[0]).toMatchObject({
          outcome: "kept",
          reason: "Contains a project checkout",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
      }),
    ),
);

it.live("keeps a checkout if its symlinked parent changes during inspection", () =>
  runCleanupTest(
    Effect.gen(function* () {
      const fixture = yield* pausedMeasurementFixture();
      const directory = yield* fixture.fs.makeTempDirectoryScoped({ prefix: "cleanup-link-" });
      const linkedParent = `${directory}/worktrees`;
      const other = `${directory}/other`;
      yield* fixture.fs.makeDirectory(other);
      yield* fixture.fs.symlink(fixture.config.worktreesDir, linkedParent);
      fixture.setThreads([shell({ branch: "feature", worktreePath: `${linkedParent}/feature` })]);
      const cleanup = yield* fixture.service.runNow.pipe(Effect.forkChild);
      yield* Deferred.await(fixture.measuring);
      yield* fixture.fs.remove(linkedParent);
      yield* fixture.fs.symlink(other, linkedParent);
      yield* Deferred.succeed(fixture.resume, undefined);
      const report = yield* Fiber.join(cleanup);
      expect(report.entries[0]).toMatchObject({ outcome: "kept" });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }),
  ),
);
