import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import type { UsageRecord } from "@goat/provider-core/server/usage";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

describe("CursorUsageAccounts", () => {
  it.effect("widens account coverage after sharing a narrower refresh", () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const since: number[] = [];
    const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
      read: (_credential, sinceMs) =>
        Effect.gen(function* () {
          since.push(sinceMs);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return { accountKey: "account", records: [], missing: false, error: null };
        }),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(10_000);
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
      const input = {
        instances: [
          {
            instanceId: ProviderInstanceId.make("cursor"),
            config: {},
            environment: [{ name: "CURSOR_API_KEY", value: "test-key", sensitive: true }],
          },
        ],
        keychainUsageEnabled: false,
        windowStartMs: 0,
        retentionCutoffMs: 1_000,
        awaitRefresh: false,
      };
      assert.isTrue((yield* accounts.scan(input))[0]?.refreshing);
      yield* Deferred.await(entered);
      const wider = yield* accounts
        .scan({ ...input, retentionCutoffMs: 0, awaitRefresh: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      assert.equal((yield* Fiber.join(wider))[0]?.status, "ok");
      assert.deepEqual(since, [1_000, 0]);
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
          Layer.provideMerge(
            TestProviderHost.layer(),
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
    );
  });

  it.effect.each(["changed", "unreadable"] as const)(
    "preserves saved usage when retention settings are %s at merge time",
    (condition) => {
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      const older: UsageRecord = {
        provider: "cursor",
        timestampMs: 5_000,
        model: "cursor-model",
        sessionId: "session",
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 7,
          reasoningTokens: 0,
        },
        speed: "standard",
        reportedCostUsd: null,
        dedupeKey: "cursor:old",
      };
      const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
        read: (_credential, sinceMs) =>
          sinceMs === 8_000
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as({ accountKey: "account", records: [], missing: false, error: null }),
              )
            : Effect.succeed({
                accountKey: "account",
                records: [older],
                missing: false,
                error: null,
              }),
      });
      return Effect.gen(function* () {
        yield* TestClock.setTime(10_000);
        const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
        const input = {
          instances: [
            {
              instanceId: ProviderInstanceId.make("cursor"),
              config: {},
              environment: [{ name: "CURSOR_API_KEY", value: "test-key", sensitive: true }],
            },
          ],
          keychainUsageEnabled: false,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        };
        yield* accounts.scan(input);
        yield* TestClock.adjust("61 seconds");
        let setting: "same" | "changed" | "unreadable" = "same";
        const request = {
          ...input,
          retentionCutoffMs: 8_000,
          withHistoryPruneGuard: (commit: (allowed: boolean) => Effect.Effect<void>) =>
            Effect.suspend(() => commit(setting === "same")),
        };
        const refresh = yield* accounts.scan(request).pipe(Effect.forkChild());
        yield* Deferred.await(entered);
        setting = condition;
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(refresh);
        assert.deepEqual(
          result[0]?.files?.flatMap((file) => file.records),
          [older],
        );
        yield* accounts.awaitPersisted;
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
            Layer.provideMerge(
              TestProviderHost.layer(),
              Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            ),
          ),
        ),
      );
    },
  );

  it.effect("retains partial history as large reads narrow and recover", () => {
    const hour = 3_600_000;
    const now = 100 * hour;
    const timestamps = [now - 40 * hour, now - 3 * hour];
    const calls: Array<{ since: number; until: number }> = [];
    const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
      read: (_credential, since, until) =>
        Effect.sync(() => {
          calls.push({ since, until });
          if (until - since > 12 * hour)
            return { accountKey: "account", records: [], missing: false, error: "too large" };
          const records: UsageRecord[] = timestamps
            .filter((time) => time >= since && time <= until)
            .map((time) => ({
              provider: "cursor",
              timestampMs: time,
              model: "model",
              sessionId: "session",
              totals: {
                uncachedInputTokens: 0,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 1,
                reasoningTokens: 0,
              },
              speed: "standard",
              reportedCostUsd: null,
              dedupeKey: String(time),
            }));
          return { accountKey: "account", records, missing: false, error: null };
        }),
    });
    return Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
      const input = {
        instances: [
          {
            instanceId: ProviderInstanceId.make("cursor"),
            config: {},
            environment: [{ name: "CURSOR_API_KEY", value: "test-key", sensitive: true }],
          },
        ],
        keychainUsageEnabled: false,
        windowStartMs: now - 48 * hour,
        retentionCutoffMs: now - 48 * hour,
        awaitRefresh: true,
      };
      yield* accounts.scan(input);
      yield* TestClock.adjust("2 minutes");
      yield* accounts.scan(input);
      yield* TestClock.adjust("2 minutes");
      const result = yield* accounts.scan(input);
      assert.deepEqual(
        result[0]?.files
          ?.flatMap((file) => file.records)
          .map((record) => record.timestampMs)
          .sort(),
        timestamps.sort(),
      );
      assert.isAbove(calls.length, 3);
      yield* accounts.awaitPersisted;
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
          Layer.provideMerge(
            TestProviderHost.layer(),
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
    );
  });

  it.effect("does not refetch a bounded window when the clock advances during enrollment", () => {
    let requests = 0;
    const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
      read: () =>
        Effect.sync(() => {
          requests++;
          return { accountKey: "account", records: [], missing: false, error: null };
        }),
    });
    return Effect.gen(function* () {
      const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
      const clock = yield* Clock.Clock;
      let now = 200 * 86400000;
      yield* accounts
        .scan({
          instances: [
            {
              instanceId: ProviderInstanceId.make("cursor"),
              config: {},
              environment: [{ name: "CURSOR_API_KEY", value: "test-key", sensitive: true }],
            },
          ],
          keychainUsageEnabled: false,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillis: Effect.sync(() => now++),
          }),
        );
      assert.equal(requests, 1);
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
          Layer.provideMerge(
            TestProviderHost.layer(),
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
    );
  });

  it.effect("runs at most two account refreshes at once and settles all of them", () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const reachedTwo = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
      read: () =>
        Effect.gen(function* () {
          inFlight++;
          mostInFlight = Math.max(mostInFlight, inFlight);
          if (inFlight === 2) yield* Deferred.succeed(reachedTwo, undefined);
          yield* Deferred.await(gate);
          return { accountKey: null, records: [], missing: false, error: null };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inFlight--;
            }),
          ),
        ),
    });
    const scan = (awaitRefresh: boolean) =>
      Effect.gen(function* () {
        const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
        return yield* accounts.scan({
          instances: ["one", "two", "three", "four"].map((key) => ({
            instanceId: ProviderInstanceId.make(`cursor-${key}`),
            config: {},
            environment: [{ name: "CURSOR_API_KEY", value: `${key}-key`, sensitive: true }],
          })),
          keychainUsageEnabled: false,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh,
        });
      });
    return Effect.gen(function* () {
      const first = yield* Effect.forkChild(scan(true));
      yield* Deferred.await(reachedTwo);
      assert.strictEqual(inFlight, 2);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      assert.strictEqual(mostInFlight, 2);
      assert.strictEqual(inFlight, 0);
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
          Layer.provideMerge(
            TestProviderHost.layer(),
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
    );
  });
});
