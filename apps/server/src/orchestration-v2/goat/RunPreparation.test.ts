import { assert, it } from "@effect/vitest";
import { CommandId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import type * as CommandReceiptStore from "../CommandReceiptStore.ts";
import { EventSinkWriteError } from "../EventSink.ts";
import * as EventSinkBatch from "../EventSinkBatch.ts";
import type * as ThreadManagement from "../ThreadManagementService.ts";
import { dispatchThenPrepare, makeRunPreparation } from "./RunPreparation.ts";

it.effect(
  "#3593: a cut caller checks its receipt only after its started batch commit settles",
  () =>
    Effect.gen(function* () {
      const batch = yield* EventSinkBatch.make(
        (cause) => new EventSinkWriteError({ eventCount: 0, cause }),
      );
      const providerStarted = yield* Deferred.make<void>();
      const providerGate = yield* Deferred.make<void>();
      const commitStarted = yield* Deferred.make<void>();
      const commitGate = yield* Deferred.make<void>();
      // Set by the commit's publish, so the receipt reads "accepted" only once the commit is done.
      const accepted = yield* Ref.make(false);
      const recovered = yield* Ref.make(false);
      // A provider event holds the worker, so the command's commit queues behind it.
      yield* batch.service
        .consumeProviderEvents(
          Stream.make({ type: "node.updated" }),
          () =>
            Deferred.succeed(providerStarted, undefined).pipe(
              Effect.andThen(Deferred.await(providerGate)),
            ),
          Effect.succeed(false),
          Effect.succeed(true),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(providerStarted);
      const receipts = {
        getByCommandId: () =>
          Ref.get(accepted).pipe(
            Effect.map((done) =>
              done
                ? Option.some({ status: "accepted" } as CommandReceiptStore.CommandReceiptV2)
                : Option.none(),
            ),
          ),
      } as unknown as CommandReceiptStore.CommandReceiptStoreV2["Service"];
      const runs = makeRunPreparation({
        threads: {} as ThreadManagement.ThreadManagementService["Service"],
        receipts,
        reservePreparation: () => Effect.die("not reached"),
        releasePreparation: () => Effect.die("not reached"),
        schedulePreparation: () => Effect.die("not reached"),
        failPreparedRun: () => Effect.die("not reached"),
        settled: batch.service.settled,
      });
      const caller = yield* Effect.uninterruptibleMask((restore) =>
        dispatchThenPrepare(
          restore,
          batch.commitThenPublish(
            Deferred.succeed(commitStarted, undefined).pipe(
              Effect.andThen(Deferred.await(commitGate)),
            ),
            () => Ref.set(accepted, true),
          ),
          runs.committed(CommandId.make("command:cut-on-batch-worker")),
          Ref.set(recovered, true),
        ),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(providerGate, undefined);
      yield* Deferred.await(commitStarted);
      caller.interruptUnsafe();
      const exitedFirst = yield* Fiber.await(caller).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "1 minute", orElse: () => Effect.succeed(false) }),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");
      assert.isFalse(
        yield* Fiber.join(exitedFirst),
        "the cut caller left before its commit settled",
      );
      yield* Deferred.succeed(commitGate, undefined);
      yield* Fiber.await(caller);
      assert.isTrue(yield* Ref.get(recovered));
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
