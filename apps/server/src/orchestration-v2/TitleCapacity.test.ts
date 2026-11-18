import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { layerEffectOutboxProvided } from "./FoundationPersistence.testkit.ts";

it.effect("reserves a general worker while title generation is slow", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const executed = yield* Deferred.make<void>();
    const workerLayer = EffectWorker.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
          Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
            execute: (effect) =>
              effect.request.type === "thread-title.generate"
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
                : Deferred.succeed(executed, undefined).pipe(Effect.asVoid),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.configureConcurrency(2);
      yield* outbox.enqueue(
        ["a", "b"].map((id) => ({
          id: `title:${id}`,
          commandId: CommandId.make(`title:${id}`),
          threadId: ThreadId.make(`title:${id}`),
          request: {
            type: "thread-title.generate" as const,
            kind: { type: "regenerate" as const },
          },
        })),
      );
      yield* worker.runGeneralOnce.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAtFor(["thread-title.generate"])));
      yield* outbox.enqueue([
        {
          id: "continue",
          commandId: CommandId.make("continue"),
          threadId: ThreadId.make("continue"),
          request: { type: "provider-runtime.continue", sourceRunId: RunId.make("continue") },
        },
      ]);
      assert.isTrue(yield* worker.runGeneralOnce);
      assert.isTrue(yield* Deferred.isDone(executed));
      yield* Deferred.succeed(release, undefined);
      yield* outbox.awaitSettled("title:a");
    }).pipe(Effect.provide(workerLayer), Effect.scoped);
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);
