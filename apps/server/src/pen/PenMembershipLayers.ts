import * as Layer from "effect/Layer";

import * as PenHubNodes from "../hubNodes/PenHubNodes.ts";
import * as PenMemberSessions from "./PenMemberSessions.ts";
import * as PenMembershipWatch from "./PenMembershipWatch.ts";

/**
 * What follows this machine's Pen membership on every server, over ssh: the fence for sessions
 * other members hold here, and one hub registration per member. Separate from the Pen target
 * (PenServerLayers) and its closed gate; both share the server's one membership watch.
 */
export const layer = Layer.mergeAll(PenMemberSessions.layer, PenHubNodes.layer).pipe(
  Layer.provide(PenMembershipWatch.layer),
);
