import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HubMachineAttachInput,
  HubMachineDetachInput,
  HubMachineList,
  HubMachineListInput,
  HubMachineReissueInput,
  HubMachineReleaseInput,
  HubMachinesError,
  HubMachineStatus,
} from "./disposableMachines.ts";

export const HUB_MACHINES_WS_METHODS = {
  hubMachinesAttach: "hub.machines.attach",
  hubMachinesReissue: "hub.machines.reissue",
  hubMachinesDetach: "hub.machines.detach",
  hubMachinesRelease: "hub.machines.release",
  hubMachinesList: "hub.machines.list",
} as const;

const HubMachinesRpcError = Schema.Union([HubMachinesError, EnvironmentAuthorizationError]);
/** A person in Settings attaching a machine they built; agents use goat_hub_machine_attach. */
const WsHubMachinesAttachRpc = Rpc.make(HUB_MACHINES_WS_METHODS.hubMachinesAttach, {
  payload: HubMachineAttachInput,
  success: HubMachineStatus,
  error: HubMachinesRpcError,
});
const WsHubMachinesReissueRpc = Rpc.make(HUB_MACHINES_WS_METHODS.hubMachinesReissue, {
  payload: HubMachineReissueInput,
  success: HubMachineStatus,
  error: HubMachinesRpcError,
});
const WsHubMachinesListRpc = Rpc.make(HUB_MACHINES_WS_METHODS.hubMachinesList, {
  payload: HubMachineListInput,
  success: HubMachineList,
  error: HubMachinesRpcError,
});
/** A person detaching a machine, or forcing it; agents use goat_hub_machine_detach. */
const WsHubMachinesDetachRpc = Rpc.make(HUB_MACHINES_WS_METHODS.hubMachinesDetach, {
  payload: HubMachineDetachInput,
  success: HubMachineStatus,
  error: HubMachinesRpcError,
});
/** A person only: frees the slot of an attach Pen cannot account for. */
const WsHubMachinesReleaseRpc = Rpc.make(HUB_MACHINES_WS_METHODS.hubMachinesRelease, {
  payload: HubMachineReleaseInput,
  success: HubMachineStatus,
  error: HubMachinesRpcError,
});

export const HubMachinesRpcs = RpcGroup.make(
  WsHubMachinesAttachRpc,
  WsHubMachinesReissueRpc,
  WsHubMachinesListRpc,
  WsHubMachinesDetachRpc,
  WsHubMachinesReleaseRpc,
);
