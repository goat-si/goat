import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Handoffs from "../../handoffs/Handoffs.ts";
import type { OrchestrationEffectV2 } from "../EffectOutbox.ts";
import { OrchestrationEffectExecutionError } from "./EffectExecution.ts";

export const makeComputerUseStop = Effect.gen(function* () {
  const handoffs = yield* Effect.serviceOption(Handoffs.Handoffs);
  return (effect: OrchestrationEffectV2) =>
    Option.isSome(handoffs)
      ? handoffs.value.stopComputerUseSessions(effect.threadId).pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new OrchestrationEffectExecutionError({
                effectId: effect.id,
                effectType: effect.request.type,
                cause,
              }),
          ),
        )
      : Effect.void;
});
