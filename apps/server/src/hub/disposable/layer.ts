import * as Layer from "effect/Layer";

import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as HubOcx from "../HubOcx.ts";
import * as DisposableAttach from "./DisposableAttach.ts";
import * as DisposableMachineStore from "./DisposableMachineStore.ts";
import * as DisposableProvisioners from "./DisposableProvisioners.ts";
import * as EnrollHost from "./EnrollHost.ts";
import * as MachineKey from "./machineKey.ts";
import { homeContractsLayer } from "./features.ts";
import * as PenInvitesSocket from "./PenInvitesSocket.ts";

/**
 * Disposable machines for the hub.machines RPCs and the MCP tools. One reference, so a server build
 * makes one instance and one reconcile loop for every caller.
 */
export const layerDisposableAttach = DisposableAttach.layer.pipe(
  Layer.provide(DisposableMachineStore.layer),
  Layer.provide(PenInvitesSocket.layer),
  Layer.provide(homeContractsLayer.pipe(Layer.provide(HubOcx.layer))),
  Layer.provide(DisposableProvisioners.layer.pipe(Layer.provide(Profiles.layer))),
  Layer.provide(EnrollHost.layer.pipe(Layer.provide(HubOcx.layer))),
  Layer.provide(MachineKey.layer),
);
