import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { EFFECT_LANES, type EffectLane } from "./EffectExecutionPolicy.ts";
import type { OrchestrationEffectV2 } from "./EffectOutbox.ts";

export class EffectExecutionFences extends Context.Service<
  EffectExecutionFences,
  {
    readonly withClaim: <E, R>(
      effect: Effect.Effect<boolean, E, R>,
    ) => Effect.Effect<boolean, E, R>;
    readonly revision: Effect.Effect<number>;
    readonly awaitChange: (revision: number) => Effect.Effect<Option.Option<Effect.Effect<void>>>;
    readonly setGeneralCapacity: (count: number) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<{
      readonly fullLanes: ReadonlyArray<EffectLane>;
      readonly titleThreads: ReadonlyArray<string>;
      readonly mainThreads: ReadonlyArray<string>;
    }>;
    readonly admissions: Effect.Effect<ReadonlyArray<OrchestrationEffectV2>>;
    readonly admitClaim: (effect: OrchestrationEffectV2) => Effect.Effect<void>;
    readonly begin: (
      claim: OrchestrationEffectV2,
    ) => Effect.Effect<Option.Option<OrchestrationEffectV2>>;
    readonly warnSlowCleanup: (claim: OrchestrationEffectV2) => Effect.Effect<void>;
    readonly retireJoined: (claim: OrchestrationEffectV2) => Effect.Effect<void>;
    readonly retireAdmission: (claim: OrchestrationEffectV2) => Effect.Effect<void>;
  }
>()("goat/orchestration-v2/EffectExecutionFences") {}

// Process-local occupancy deliberately supplies no native retirement or restart guarantee.
export const layer = Layer.sync(EffectExecutionFences, () => {
  // Each decoded claim object identifies its generation, even when a retry refunds its attempt.
  const active = new Map<string, { effect: OrchestrationEffectV2; executing: boolean }>();
  let claims = 0;
  let revision = 0;
  let changed = Deferred.makeUnsafe<void>();
  const notifyChanged = (progress = true) => {
    if (progress) revision++;
    const previous = changed;
    changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  };
  let generalCapacity = 4;
  return EffectExecutionFences.of({
    withClaim: Effect.fn("EffectExecutionFences.withClaim")(
      <E, R>(effect: Effect.Effect<boolean, E, R>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            claims++;
          }),
          () => effect,
          (_, exit) =>
            Effect.sync(() => {
              claims--;
              // Empty probes must not make drain observe its own probe as new work.
              notifyChanged(Exit.isFailure(exit) || exit.value);
            }),
        ),
    ),
    revision: Effect.sync(() => revision),
    awaitChange: Effect.fn("EffectExecutionFences.awaitChange")((observed) =>
      Effect.sync(() =>
        observed !== revision
          ? Option.some(Effect.void)
          : claims === 0 && active.size === 0
            ? Option.none()
            : Option.some(Deferred.await(changed)),
      ),
    ),
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
    admissions: Effect.sync(() => Array.from(active.values(), ({ effect }) => effect)),
    admitClaim: Effect.fn("EffectExecutionFences.admitClaim")((effect) =>
      Effect.sync(() => {
        active.set(effect.id, { effect, executing: false });
        notifyChanged();
      }),
    ),
    begin: Effect.fn("EffectExecutionFences.begin")((claim) =>
      Effect.sync(() => {
        const entry = active.get(claim.id);
        if (entry?.effect !== claim) return Option.none();
        entry.executing = true;
        return Option.some(claim);
      }),
    ),
    warnSlowCleanup: Effect.fn("EffectExecutionFences.warnSlowCleanup")((claim) =>
      Effect.suspend(() => {
        const entry = active.get(claim.id);
        return entry?.effect !== claim
          ? Effect.void
          : Effect.logWarning("orchestration-v2.effect-cleanup-unresolved", {
              lane: EFFECT_LANES[entry.effect.request.type],
              effectType: entry.effect.request.type,
              count: 1,
            });
      }),
    ),
    retireJoined: Effect.fn("EffectExecutionFences.retireJoined")((claim) =>
      Effect.sync(() => {
        if (active.get(claim.id)?.effect === claim) {
          active.delete(claim.id);
          notifyChanged();
        }
      }),
    ),
    retireAdmission: Effect.fn("EffectExecutionFences.retireAdmission")((claim) =>
      Effect.sync(() => {
        const entry = active.get(claim.id);
        if (entry?.effect === claim && !entry.executing) {
          active.delete(claim.id);
          notifyChanged();
        }
      }),
    ),
  });
});
