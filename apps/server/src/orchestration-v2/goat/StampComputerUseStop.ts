import * as Effect from "effect/Effect";
import type * as EffectOutbox from "../EffectOutbox.ts";
import type * as EventStore from "../EventStore.ts";

export const stampComputerUseStop = Effect.fn("EventSink.stampComputerUseStop")(function* (
  effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>,
  events: EventStore.EventStoreV2["Service"],
) {
  if (!effects.some((effect) => effect.request.type === "computer-use.stop")) return effects;
  const cutoff = yield* events.latestApplicationSequence;
  return effects.map((effect) =>
    effect.request.type === "computer-use.stop"
      ? { ...effect, request: { ...effect.request, cutoff } }
      : effect,
  );
});
