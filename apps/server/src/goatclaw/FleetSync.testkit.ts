import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GoatclawFleetSync } from "./FleetSync.ts";

/** Fleet sync for tests whose hosts never confirm goatclaw: profiled remote sends are refused. */
export const layerNoFleetSync = Layer.mock(GoatclawFleetSync)({
  ensure: () => Effect.succeed({ sync: { state: "pending" }, enforcesCeilings: false }),
  reconcile: Effect.void,
});
