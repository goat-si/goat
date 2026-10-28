import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { EFFECT_LANES, type EffectLane } from "./EffectExecutionPolicy.ts";
import type { OrchestrationEffectV2 } from "./EffectOutbox.ts";

export class EffectExecutionFences extends Context.Service<
  EffectExecutionFences,
  {
    readonly setGeneralCapacity: (count: number) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<{
      readonly fullLanes: ReadonlyArray<EffectLane>;
      readonly titleThreads: ReadonlyArray<string>;
      readonly mainThreads: ReadonlyArray<string>;
    }>;
    readonly admitClaim: (effect: OrchestrationEffectV2) => Effect.Effect<void>;
    readonly begin: (effectId: string) => Effect.Effect<Option.Option<string>>;
    readonly warnSlowCleanup: (token: string) => Effect.Effect<void>;
    readonly retireJoined: (token: string) => Effect.Effect<void>;
    readonly retireAdmission: (effectId: string) => Effect.Effect<void>;
  }
>()("goat/orchestration-v2/EffectExecutionFences") {}

// Process-local occupancy deliberately supplies no native retirement or restart guarantee.
export const layer = Layer.sync(EffectExecutionFences, () => {
  const active = new Map<string, { effect: OrchestrationEffectV2; executing: boolean }>();
  let generalCapacity = 4;
  return EffectExecutionFences.of({
    setGeneralCapacity: Effect.fn("EffectExecutionFences.setGeneralCapacity")((count) =>
      Effect.sync(() => {
        generalCapacity = count;
      }),
    ),
    snapshot: Effect.sync(() => {
      const counts = { general: 0, control: 0, cleanup: 0 };
      const titleThreads: string[] = [];
      const mainThreads: string[] = [];
      for (const { effect } of active.values()) {
        counts[EFFECT_LANES[effect.request.type]]++;
        (effect.request.type === "thread-title.generate" ? titleThreads : mainThreads).push(
          effect.threadId,
        );
      }
      return {
        fullLanes: (["general", "control", "cleanup"] as const).filter(
          (lane) => counts[lane] >= (lane === "general" ? generalCapacity : 1),
        ),
        titleThreads,
        mainThreads,
      };
    }),
    admitClaim: Effect.fn("EffectExecutionFences.admitClaim")((effect) =>
      Effect.sync(() => {
        active.set(effect.id, { effect, executing: false });
      }),
    ),
    begin: Effect.fn("EffectExecutionFences.begin")((effectId) =>
      Effect.sync(() => {
        const entry = active.get(effectId);
        if (entry === undefined) return Option.none();
        entry.executing = true;
        return Option.some(effectId);
      }),
    ),
    warnSlowCleanup: Effect.fn("EffectExecutionFences.warnSlowCleanup")((token) =>
      Effect.suspend(() => {
        const entry = active.get(token);
        return entry === undefined
          ? Effect.void
          : Effect.logWarning("orchestration-v2.effect-cleanup-unresolved", {
              lane: EFFECT_LANES[entry.effect.request.type],
              effectType: entry.effect.request.type,
              count: 1,
            });
      }),
    ),
    retireJoined: Effect.fn("EffectExecutionFences.retireJoined")((token) =>
      Effect.sync(() => {
        active.delete(token);
      }),
    ),
    retireAdmission: Effect.fn("EffectExecutionFences.retireAdmission")((effectId) =>
      Effect.sync(() => {
        if (active.get(effectId)?.executing === false) active.delete(effectId);
      }),
    ),
  });
});
