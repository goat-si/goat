import * as Layer from "effect/Layer";

import * as BoatClient from "../cloudMachines/BoatClient.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as CloudMachineSsh from "../cloudMachines/sshConfig.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as HubNodeRepository from "../hubNodes/HubNodeRepository.ts";
import * as PenManagedRoutes from "../hubNodes/PenManagedRoutes.ts";
import * as PenMembershipWatch from "../pen/PenMembershipWatch.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

/** The runtime's one cloud machine service; WS, MCP and dispatch share this reference. */
export const layerCloudMachines = CloudMachineService.layerWithoutDependencies.pipe(
  Layer.provide(BoatClient.layer),
  Layer.provide(CloudMachineSsh.layer()),
);

/**
 * The runtime's one set of Pen-managed ssh aliases, shared by reference by dispatch (which guards
 * them) and HubNodes (which writes them). Dispatch reads it as a reference whose default refuses
 * every Pen alias, so a build without this provide reaches no Pen machine instead of an unguarded one.
 */
export const layerPenRoutes = PenManagedRoutes.layer.pipe(
  Layer.provide(PenMembershipWatch.layer),
  Layer.provide(HubNodeRepository.layer),
);

/**
 * The runtime's one dispatch, shared by reference so every consumer shares one tunnel manager.
 * Dispatch reads cloud machines and linked hosts as optional services, and a memoized layer keeps
 * the context of its first build, which can sit outside where the runtime provides them; without
 * these provides it silently treats every Boat alias as unknown (#863).
 */
export const layer = SshRemoteDispatch.layer.pipe(
  Layer.provide(layerCloudMachines),
  Layer.provide(LinkedHosts.layer),
  Layer.provide(layerPenRoutes),
);
