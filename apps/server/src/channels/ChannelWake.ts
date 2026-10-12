/**
 * ChannelWake - tells the channel workers that the ledger has new work.
 *
 * Writers call `wake` after their transaction commits. The signal carries nothing: workers
 * always read what to do from the ledger, so a lost or duplicated signal only changes when work
 * happens, never what happens.
 *
 * @module ChannelWake
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

export class ChannelWake extends Context.Service<
  ChannelWake,
  {
    readonly wake: Effect.Effect<void>;
    /** Waits for the next signal and clears any that piled up meanwhile. */
    readonly next: Effect.Effect<void>;
  }
>()("goat/channels/ChannelWake") {}

const make = Effect.gen(function* () {
  const signals = yield* Queue.sliding<void>(1);
  return ChannelWake.of({
    wake: Queue.offer(signals, undefined).pipe(Effect.asVoid),
    next: Queue.take(signals).pipe(Effect.asVoid),
  });
});

export const layer = Layer.effect(ChannelWake, make);
