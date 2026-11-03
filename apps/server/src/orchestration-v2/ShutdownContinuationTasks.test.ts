import { assert, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { runShutdownContinuationTasks } from "./ShutdownContinuationTasks.ts";

it.effect("a blocked failed read does not prevent another continuation from committing", () =>
  Effect.gen(function* () {
    const broken = ThreadId.make("broken");
    const ready = ThreadId.make("ready");
    const release = yield* Deferred.make<void>();
    const committed = yield* Deferred.make<void>();
    const preparing = yield* runShutdownContinuationTasks([broken, ready], (id) =>
      id === broken
        ? Deferred.await(release).pipe(Effect.andThen(Effect.fail("read failed")))
        : Deferred.succeed(committed, undefined).pipe(Effect.as(true)),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(committed);
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Fiber.join(preparing), { candidates: 2, continued: 1 });
  }),
);

it.effect("interrupting shutdown prevents unstarted candidate reads", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const blocked = yield* Deferred.make<void>();
    const ids = Array.from({ length: 5 }, (_, index) => ThreadId.make(`thread:${index}`));
    const reads: ThreadId[] = [];
    const preparing = yield* runShutdownContinuationTasks(ids, (id) =>
      Effect.gen(function* () {
        reads.push(id);
        if (reads.length === 4) yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(blocked);
        return true;
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* Fiber.interrupt(preparing);
    assert.lengthOf(reads, 4);
    assert.notInclude(reads, ids[4]);
  }),
);
