import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as AutomationHold from "../automationHold.ts";
import * as Sync from "./MemorySyncService.ts";
import {
  timestamp,
  peer,
  realGeneration,
  fixture,
  ready,
  conflict,
  sourceFixture,
} from "./MemorySyncService.testkit.ts";

it.effect("automation hold prevents memory transport and dispatch; release resumes sync", () =>
  Effect.gen(function* () {
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    const pulled = yield* Deferred.make<void>();
    const dispatched = yield* Deferred.make<void>();
    const transports: string[] = [];
    const client = peer({
      pull: (_connection, input) =>
        Effect.sync(() => transports.push("pull")).pipe(
          Effect.andThen(Deferred.succeed(pulled, undefined)),
          Effect.as({
            highWatermark: input.afterSequence,
            throughSequence: input.afterSequence,
            hasMore: false,
            entries: [],
          }),
        ),
      claim: (_connection, { protocolVersion: _protocol, ...claim }) =>
        Effect.sync(() => transports.push("claim")).pipe(
          Effect.as({
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          }),
        ),
      requestSourceRead: () =>
        Effect.sync(() => transports.push("source")).pipe(
          Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" }))),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const validated = yield* sourceFixture;
        const sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        yield* sync.syncOnce;
        yield* sync.scheduleConflictResolution;
        assert.strictEqual(
          (yield* Effect.result(sync.readSource(validated, Effect.void)))._tag,
          "Failure",
        );
        yield* TestClock.adjust("30 seconds");
        assert.deepStrictEqual(transports, []);
        assert.strictEqual(yield* sync.activeResolutions, 0);
        yield* hold.release;
        yield* Deferred.await(pulled);
        yield* Deferred.await(dispatched);
        assert.include(transports, "pull");
        assert.include(transports, "claim");
      }).pipe(
        Effect.provide(
          fixture(
            client,
            realGeneration({
              resolveMemoryConflict: () =>
                Deferred.succeed(dispatched, undefined).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        ),
        Effect.provideService(AutomationHold.AutomationHold, hold),
      ),
    );
  }),
);
