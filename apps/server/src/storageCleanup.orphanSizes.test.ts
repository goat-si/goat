import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { NOW_MS, allocatedBytes } from "./storageCleanup.testFixtures.ts";
import { cleanupFixture, runCleanupTest } from "./storageCleanup.testkit.ts";

describe("orphan worktree sizes", () => {
  it.effect(
    "measures new orphans first and rotates cached refreshes when the budget runs out, not counting discovery",
    () =>
      runCleanupTest(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const clock = yield* Clock.Clock;
          let now = NOW_MS;
          let parent: string | undefined;
          let slowDirectory: string | undefined;
          let slowDiscovery: string | undefined;
          const fixture = yield* cleanupFixture().pipe(
            Effect.provideService(Clock.Clock, {
              ...clock,
              currentTimeMillis: Effect.sync(() => now),
            }),
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readDirectory: (directory, options) =>
                fs.readDirectory(directory, options).pipe(
                  Effect.map((names) => {
                    if (directory === slowDirectory || directory === slowDiscovery) now += 30_000;
                    return directory === parent ? names.sort() : names;
                  }),
                ),
            }),
          );
          fixture.setThreads([]);
          parent = `${fixture.config.worktreesDir}/repository`;
          const cached = `${parent}/a-cached`;
          const later = `${parent}/b-cached`;
          const discovered = `${parent}/c-discovered`;
          for (const directory of [cached, later]) {
            yield* fs.makeDirectory(`${directory}/build`, { recursive: true });
            yield* fs.utimes(directory, 1, 1);
          }
          const bundle = `${later}/build/bundle.js`;
          yield* fs.writeFileString(bundle, "x".repeat(64 * 1024));
          const size = yield* allocatedBytes(fs, bundle);
          const first = yield* fixture.service.runNow;
          expect(first.entries.find((entry) => entry.path === later)?.bytes).toBe(size);

          slowDirectory = `${cached}/build`;
          yield* fs.remove(bundle);
          yield* fs.makeDirectory(discovered);
          yield* fs.utimes(discovered, 1, 1);
          const second = yield* fixture.service.runNow;
          expect(second.entries.find((entry) => entry.path === discovered)?.bytes).toBe(0);
          expect(second.entries.find((entry) => entry.path === later)?.bytes).toBe(size);

          slowDiscovery = parent;
          const third = yield* fixture.service.runNow;
          expect(third.entries.find((entry) => entry.path === later)?.bytes).toBe(0);
        }),
      ),
  );

  it.live("retains the last orphan size on a failed refresh and can refresh it later", () =>
    runCleanupTest(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let unreadable: string | undefined;
        const fixture = yield* cleanupFixture().pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: (directory, options) =>
              fs.readDirectory(
                directory === unreadable ? `${directory}/missing-directory` : directory,
                options,
              ),
          }),
        );
        fixture.setThreads([]);
        const orphan = `${fixture.config.worktreesDir}/repository/orphan`;
        const build = `${orphan}/build`;
        const bundle = `${build}/bundle.js`;
        yield* fs.makeDirectory(build, { recursive: true });
        yield* fs.writeFileString(bundle, "build output");
        yield* fs.utimes(orphan, 1, 1);
        const size = yield* allocatedBytes(fs, bundle);
        const orphanBytes = Effect.map(
          fixture.service.runNow,
          (report) => report.entries.find((entry) => entry.path === orphan)?.bytes,
        );
        expect(yield* orphanBytes).toBe(size);
        yield* fs.remove(bundle);
        unreadable = build;
        expect(yield* orphanBytes).toBe(size);
        unreadable = undefined;
        expect(yield* orphanBytes).toBe(0);
      }),
    ),
  );
});
