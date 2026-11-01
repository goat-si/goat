import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PlacementHostConditions } from "../resources/Placement.ts";
import * as FleetHostStates from "./FleetHostStates.ts";
import * as Health from "./Health.ts";
import * as HostHealthMonitor from "./HostHealthMonitor.ts";
import * as Rescheduler from "./Rescheduler.ts";

/** Placement (T3) skips the hosts cordoned or draining here. */
export const layerPlacementConditions = Layer.effect(
  PlacementHostConditions,
  Effect.gen(function* () {
    const states = yield* FleetHostStates.FleetHostStates;
    return { cordoned: states.cordonedHosts };
  }),
);

/**
 * Health and Rescheduler behind the tags the goal controller reads, over one host monitor, plus the
 * cordons placement reads. Placement itself comes from fleet/resources.
 */
export const layer = Layer.mergeAll(Health.layer, Rescheduler.layer).pipe(
  Layer.provideMerge(layerPlacementConditions),
  Layer.provideMerge(HostHealthMonitor.layer),
  Layer.provideMerge(Layer.mergeAll(FleetHostStates.layer, FleetHostStates.layerClaims)),
);
