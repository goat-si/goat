import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as AutomationHold from "../automationHold.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";

it.effect("does not busy-wake for copied running threads and wakes immediately on release", () =>
  Effect.gen(function* () {
    const hold = yield* AutomationHold.makeInMemory({ reason: "channel-copy", heldAt: "" });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const idle = yield* Deferred.make<void>();
      const executed = yield* Queue.unbounded<string>();
      let claims = 0;
      const pending = (id: string) => ({
        id,
        commandId: CommandId.make(id),
        threadId: ThreadId.make("copied-running-thread"),
        request: { type: "terminal.cleanup" as const },
      });
      yield* outbox.enqueue([pending("copied-running")]);
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running'`;
      yield* Effect.gen(function* () {
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        // Recovery can requeue a running effect after the worker captured the copy.
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'pending'`;
        yield* outbox.enqueue([pending("same-thread-new")]);
        assert.isTrue(Option.isNone(yield* worker.nextClaimableAt));
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
        yield* Deferred.await(idle);
        yield* TestClock.adjust("1 second");
        assert.equal(claims, 1);
        assert.equal(yield* Queue.size(executed), 0);
        yield* hold.release;
        assert.equal(yield* Queue.take(executed), "copied-running");
        assert.equal(yield* Queue.take(executed), "same-thread-new");
        yield* outbox.awaitSettled("same-thread-new");
      }).pipe(
        Effect.provide(
          EffectWorker.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EffectOutbox.EffectOutboxV2, {
                  ...outbox,
                  claimNext: (input) =>
                    Effect.sync(() => {
                      claims += 1;
                    }).pipe(Effect.andThen(outbox.claimNext(input))),
                  awaitAvailable: Deferred.succeed(idle, undefined).pipe(
                    Effect.andThen(outbox.awaitAvailable),
                  ),
                }),
                Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
                  execute: (effect) => Queue.offer(executed, effect.id).pipe(Effect.asVoid),
                }),
              ),
            ),
          ),
        ),
        Effect.scoped,
      );
    }).pipe(
      Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
      Effect.provideService(AutomationHold.AutomationHold, hold),
    );
  }),
);
