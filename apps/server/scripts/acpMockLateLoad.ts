import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export const delayedLoadResponse = Effect.fn("AcpMock.delayedLoadResponse")(function* <
  Config,
  E,
  R,
>(input: {
  readonly replay: Effect.Effect<unknown, E, R>;
  readonly config: () => Config;
  readonly hold: boolean;
  readonly release: Deferred.Deferred<void>;
  readonly replied: Deferred.Deferred<void>;
  readonly delayMs: number;
  readonly notify: Effect.Effect<unknown, E, R>;
}) {
  yield* input.replay;
  const loadedConfig = input.config();
  if (input.hold) yield* Deferred.await(input.release);
  yield* input.notify;
  if (!input.hold) yield* Effect.sleep(input.delayMs);
  yield* Deferred.succeed(input.replied, undefined);
  return { configOptions: input.hold ? loadedConfig : input.config() };
});
