import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HubMachineAttachInput,
  HubMachineList,
  HubMachineListInput,
  HubMachineReissueInput,
  HubMachinesError,
  HubMachineStatus,
} from "./disposableMachines.ts";

export const HUB_MACHINES_WS_METHODS = {
  hubMachinesAttach: "hub.machines.attach",
  hubMachinesReissue: "hub.machines.reissue",
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

export const HubMachinesRpcs = RpcGroup.make(
  WsHubMachinesAttachRpc,
  WsHubMachinesReissueRpc,
  WsHubMachinesListRpc,
);
