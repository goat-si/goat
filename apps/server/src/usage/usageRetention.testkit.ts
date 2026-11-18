// @effect-diagnostics nodeBuiltinImport:off - fixtures set transcript modification times.
import { assert, it } from "@effect/vitest";
import { UsageDay } from "@goat/contracts";
import * as CursorUsageAccounts from "@goat/provider-cursor/server/CursorUsageAccounts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFSP from "node:fs/promises";
import * as ServerSettings from "../serverSettings.ts";
import { totalOutputTokens } from "./UsageAssertions.testkit.ts";
import * as UsageService from "./UsageService.ts";
import type * as Main from "./UsageService.test.ts";
import { WINDOW } from "./usageUnpriced.testkit.ts";

export function registerUsageRetentionTests(
  setup: typeof Main.setup,
  layerService: typeof Main.layerService,
  claudeLine: typeof Main.claudeLine,
) {
  it.effect.each([
    { label: "the default 92 days", retention: undefined, expected: 1 },
    { label: "unlimited", retention: "unlimited" as const, expected: 15 },
  ])(
    "retains deleted transcripts according to $label across restart and settings changes",
    ({ retention, expected }) =>
      Effect.gen(function* () {
        const { transcript, settings, home } = yield* setup;
        const now = Date.parse("2026-08-02T12:00:00Z");
        yield* TestClock.setTime(now);
        const window = { ...WINDOW, sinceDay: UsageDay.make("2024-01-01") };
        const files = [92, 93, 180, 730].map((days, index) => ({
          path: `${transcript}-${index}.jsonl`,
          timestamp: now - days * 86400000,
          content: claudeLine(index, 2 ** index).replace(
            "2026-08-01T10:00:00Z",
            DateTime.formatIso(DateTime.makeUnsafe(now - days * 86400000)),
          ),
        }));
        yield* Effect.promise(async () => {
          for (const file of files) {
            await NodeFSP.writeFile(file.path, file.content);
            await NodeFSP.utimes(file.path, file.timestamp / 1000, file.timestamp / 1000);
          }
        });
        yield* Effect.gen(function* () {
          const service = yield* UsageService.make;
          const first = yield* service.readSummary(window);
          assert.strictEqual(totalOutputTokens(first), 15);
          yield* service.awaitPersisted;
          yield* Effect.promise(() => Promise.all(files.map((file) => NodeFSP.rm(file.path))));
          const restarted = yield* UsageService.make;
          const saved = yield* restarted.readSummary(window);
          assert.strictEqual(totalOutputTokens(saved), expected);
          assert.deepStrictEqual(saved.sources[0]?.fingerprint, first.sources[0]?.fingerprint);
          const narrow = yield* restarted.readSummary(WINDOW);
          assert.strictEqual(totalOutputTokens(narrow), 0);
          assert.strictEqual(narrow.sources[0]?.distinctSessions, 0);

          const config = yield* ServerSettings.ServerSettingsService;
          yield* config.updateSettings({ usageHistoryRetentionDays: 1 });
          assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(window)), 0);
          yield* restarted.awaitPersisted;
          yield* config.updateSettings({ usageHistoryRetentionDays: "unlimited" });
          const afterPruning = yield* UsageService.make;
          assert.strictEqual(totalOutputTokens(yield* afterPruning.readSummary(window)), 0);
        }).pipe(
          Effect.provide(
            layerService({
              prefix: "usage-service-retention",
              home,
              settings: {
                ...settings,
                ...(retention === undefined ? {} : { usageHistoryRetentionDays: retention }),
              },
            }),
          ),
        );
      }),
  );

  it.effect("keeps retained history when an obsolete scan finishes after retention widens", () =>
    Effect.gen(function* () {
      const { transcript, settings, home } = yield* setup;
      yield* TestClock.setTime(Date.parse("2026-08-02T12:00:00Z"));
      const timestamp = Date.parse("2026-08-02T12:00:00Z") - 180 * 86400000;
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          transcript,
          claudeLine(1, 11).replace(
            "2026-08-01T10:00:00Z",
            DateTime.formatIso(DateTime.makeUnsafe(timestamp)),
          ),
        );
        await NodeFSP.utimes(transcript, timestamp / 1000, timestamp / 1000);
      });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let scans = 0;
      yield* Effect.gen(function* () {
        const config = yield* ServerSettings.ServerSettingsService;
        const service = yield* UsageService.make.pipe(
          Effect.provideService(CursorUsageAccounts.CursorUsageAccounts, {
            scan: () =>
              Effect.gen(function* () {
                if (++scans === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }
                return [];
              }),
            awaitPersisted: Effect.void,
          }),
        );
        const window = { ...WINDOW, sinceDay: UsageDay.make("2024-01-01") };
        const oldScan = yield* service.readSummary(window).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* config.updateSettings({ usageHistoryRetentionDays: "unlimited" });
        assert.strictEqual(totalOutputTokens(yield* service.readSummary(window)), 11);
        yield* service.awaitPersisted;
        yield* Effect.promise(() => NodeFSP.rm(transcript));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(oldScan);
        yield* service.awaitPersisted;
        const restarted = yield* UsageService.make;
        assert.strictEqual(totalOutputTokens(yield* restarted.readSummary(window)), 11);
      }).pipe(Effect.provide(layerService({ prefix: "usage-retention-race", home, settings })));
    }),
  );
}
