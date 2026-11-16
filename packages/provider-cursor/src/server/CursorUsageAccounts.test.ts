import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { CURSOR_ACCOUNT_CACHE_FILE_NAME, encodeCursorAccountCaches } from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

describe("CursorUsageAccounts", () => {
  it.effect("rescans past a v1 or malformed cache and leaves the v1 file for an older build", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const credentialKey = `api-key:${Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode("one-key")))}`;
      const fresh = { accountKey: "account-one", sinceMs: 0, untilMs: 0, fetchedAtMs: 0 };
      const v2 = encodeCursorAccountCaches(new Map([[credentialKey, { ...fresh, records: [] }]]));
      const v1 = JSON.stringify({ ...JSON.parse(v2), version: 1 });
      for (const [fileName, contents, reads] of [
        [CURSOR_ACCOUNT_CACHE_FILE_NAME, v2, 0],
        ["usage-cursor-account-cache-v1.json", v1, 1],
        [CURSOR_ACCOUNT_CACHE_FILE_NAME, v1, 1],
        [CURSOR_ACCOUNT_CACHE_FILE_NAME, "{not json", 1],
      ] as const) {
        let read = 0;
        const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
          read: () =>
            Effect.sync(() => {
              read++;
              return { accountKey: "account-one", records: [], missing: false, error: null };
            }),
        });
        yield* Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const cachePath = (yield* Path.Path).join(
            (yield* ProviderHost.ProviderHost).paths.stateDir,
            fileName,
          );
          yield* fileSystem.writeFileString(cachePath, contents);
          const accounts = yield* CursorUsageAccounts.CursorUsageAccounts;
          yield* accounts.scan({
            instances: [
              {
                instanceId: ProviderInstanceId.make("cursor-one"),
                config: {},
                environment: [{ name: "CURSOR_API_KEY", value: "one-key", sensitive: true }],
              },
            ],
            keychainUsageEnabled: false,
            windowStartMs: 0,
            retentionCutoffMs: 0,
            awaitRefresh: true,
          });
          yield* accounts.awaitPersisted;
          assert.strictEqual(read, reads, `${fileName} ${contents.slice(0, 12)}`);
          if (fileName !== CURSOR_ACCOUNT_CACHE_FILE_NAME) {
            assert.strictEqual(yield* fileSystem.readFileString(cachePath), contents);
          }
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              CursorUsageAccounts.layer.pipe(Layer.provide(reader)),
              Layer.provideMerge(TestProviderHost.layer(), NodeServices.layer),
            ),
          ),
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
          Layer.provideMerge(TestProviderHost.layer(), NodeServices.layer),
        ),
      ),
    );
  });
});
