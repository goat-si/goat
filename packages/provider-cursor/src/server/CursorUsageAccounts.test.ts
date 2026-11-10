import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

describe("CursorUsageAccounts", () => {
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
            environment: { CURSOR_API_KEY: `${key}-key` },
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
