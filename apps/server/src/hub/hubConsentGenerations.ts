import type { ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

/** Committed changes of the hub switch, and of whether cloud machines may join. */
export interface HubConsentGenerations {
  readonly hub: number;
  readonly cloud: number;
}

type Hub = Pick<ServerSettings["hub"], "enabled" | "autoJoinCloudMachines">;
const cloudAllowed = (hub: Hub) => hub.enabled && hub.autoJoinCloudMachines;

/**
 * Advanced inside each settings commit, before any subscriber runs, so consent bound to a
 * generation never survives an off-then-on that a slow subscriber has not seen. The first
 * commit only sets the baseline: a single commit cannot turn a switch off and on again.
 */
export const makeHubConsentGenerations = Effect.gen(function* () {
  const state = yield* Ref.make<{
    readonly last: Hub | undefined;
    readonly generations: HubConsentGenerations;
  }>({ last: undefined, generations: { hub: 0, cloud: 0 } });
  return {
    current: Ref.get(state).pipe(Effect.map((value) => value.generations)),
    committed: (hub: Hub) =>
      Ref.update(state, ({ last, generations }) => ({
        last: hub,
        generations:
          last === undefined
            ? generations
            : {
                hub: generations.hub + (last.enabled === hub.enabled ? 0 : 1),
                cloud: generations.cloud + (cloudAllowed(last) === cloudAllowed(hub) ? 0 : 1),
              },
      })),
  };
});
