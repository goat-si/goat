import * as Layer from "effect/Layer";

import * as BoatClient from "../cloudMachines/BoatClient.ts";
import * as CloudMachineService from "../cloudMachines/CloudMachineService.ts";
import * as CloudMachineSsh from "../cloudMachines/sshConfig.ts";
import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

/** The runtime's one cloud machine service; WS, MCP and dispatch share this reference. */
export const layerCloudMachines = CloudMachineService.layerWithoutDependencies.pipe(
  Layer.provide(BoatClient.layer),
  Layer.provide(CloudMachineSsh.layer()),
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
);
