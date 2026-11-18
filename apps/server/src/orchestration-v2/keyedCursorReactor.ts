import * as KeyedLock from "@goat/shared/KeyedLock";
import * as Effect from "effect/Effect";
import { supervise } from "../backgroundSupervision.ts";

type CursorRange = { readonly afterSequence: number; readonly throughSequence: number };

/** One reserved job per saturated key retains cursors instead of committed event payloads. */
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
  const deferred = new Map<Key, Map<Source, CursorRange>>();
  const remember = (ranges: Map<Source, CursorRange>, source: Source, sequence: number) => {
    ranges.set(source, {
      afterSequence: ranges.get(source)?.afterSequence ?? sequence - 1,
      throughSequence: sequence,
    });
  };

  // Intake checks each stored event. The replay is traced and supervised as one operation.
  const enqueue = Effect.fnUntraced(function* <R2>(
    key: Key,
    source: Source,
    sequence: number,
    reaction: Effect.Effect<unknown, never, R2>,
  ) {
    const existing = deferred.get(key);
    if (existing !== undefined) {
      remember(existing, source, sequence);
      return false;
    }
    if (yield* runner.tryRun(key, reaction)) return true;
    const waiting = deferred.get(key);
    if (waiting !== undefined) {
      remember(waiting, source, sequence);
      return false;
    }
    const ranges = new Map<Source, CursorRange>();
    remember(ranges, source, sequence);
    deferred.set(key, ranges);
    yield* runner.runOverflow(
      key,
      Effect.gen(function* () {
        for (const [nextSource, range] of ranges) {
          ranges.delete(nextSource);
          yield* supervise(input.name, () => input.replay(key, nextSource, range), {
            restartOnSuccess: false,
          });
        }
        deferred.delete(key);
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => deferred.delete(key)))),
    );
    return false;
  });

  return { enqueue, run: runner.run };
});
