import * as KeyedLock from "@goat/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { supervise } from "../backgroundSupervision.ts";

type CursorRange = { readonly afterSequence: number; readonly throughSequence: number };
type DeferredWork<Source> = { readonly ranges: Map<Source, CursorRange>; scheduled: boolean };

const MAX_DEFERRED_KEYS = 128;

/** Retains journal ranges while a key or the runner is at capacity. */
export const makeKeyedCursorReactor = Effect.fn("KeyedCursorReactor.make")(function* <
  Key,
  Source,
  E,
  R,
>(input: {
  readonly name: string;
  readonly replay: (key: Key, source: Source, range: CursorRange) => Effect.Effect<unknown, E, R>;
}) {
  const runner = yield* KeyedLock.makeRunner<Key>(8);
  const wakeScheduler = yield* Queue.sliding<void>(1);
  const deferred = new Map<Key, DeferredWork<Source>>();
  const schedule = Effect.gen(function* () {
    const changed = runner.awaitChange();
    for (const [key, work] of deferred) {
      if (work.scheduled) continue;
      work.scheduled = true;
      const admitted = yield* runner.tryRunOverflow(
        key,
        Effect.gen(function* () {
          for (const [source, range] of work.ranges) {
            work.ranges.delete(source);
            yield* supervise(input.name, () => input.replay(key, source, range), {
              restartOnSuccess: false,
            });
          }
          deferred.delete(key);
        }),
      );
      if (!admitted) work.scheduled = false;
    }
    yield* Effect.raceFirst(Queue.take(wakeScheduler), changed);
  });
  yield* schedule.pipe(Effect.forever, Effect.forkScoped);

  // Intake checks each stored event. The replay is traced and supervised as one operation.
  const enqueue = Effect.fnUntraced(function* <R2>(
    key: Key,
    source: Source,
    sequence: number,
    reaction: Effect.Effect<unknown, never, R2>,
  ): Effect.fn.Return<boolean, never, R2> {
    const changed = runner.awaitChange();
    const work = deferred.get(key);
    if (work !== undefined) {
      const previous = work.ranges.get(source);
      work.ranges.set(source, {
        afterSequence: previous?.afterSequence ?? sequence - 1,
        throughSequence: sequence,
      });
      return false;
    }
    if (yield* runner.tryRun(key, reaction)) return true;
    // Congestion on 128 distinct keys can defer the source itself at its durable cursor.
    if (deferred.has(key)) return yield* enqueue(key, source, sequence, reaction);
    if (deferred.size >= MAX_DEFERRED_KEYS) {
      yield* changed;
      return yield* enqueue(key, source, sequence, reaction);
    }
    deferred.set(key, {
      ranges: new Map([[source, { afterSequence: sequence - 1, throughSequence: sequence }]]),
      scheduled: false,
    });
    yield* Queue.offer(wakeScheduler, undefined);
    return false;
  });

  return { enqueue, run: runner.run };
});
