import * as Layer from "effect/Layer";

import * as PenEnablement from "./PenEnablement.ts";
import * as PenMembership from "./PenMembershipLayers.ts";
import { layerPenRouteGate, layerPenSessionRoute } from "./PenHttp.ts";
import * as PenRegistrar from "./PenRegistrar.ts";
import * as PenRuntime from "./PenRuntime.ts";
import * as PenSessions from "./PenSessions.ts";

/**
 * The Pen target as the server runs it: the route gate, the member session route and the runtime,
 * sharing one PenSessions, behind the build's closed PenEnablement.
 */
export const layer = Layer.mergeAll(layerPenRouteGate, layerPenSessionRoute, PenRuntime.layer).pipe(
  Layer.provide(PenRegistrar.layer),
  Layer.provideMerge(PenSessions.layer),
  Layer.provideMerge(PenEnablement.layer),
);

export { layerMainHttpServer, MainHttpServer } from "./PenRuntime.ts";

/** What Pen adds to a server: the target above, and the membership followers beside it. */
export const layerWithMembership = Layer.merge(layer, PenMembership.layer);
