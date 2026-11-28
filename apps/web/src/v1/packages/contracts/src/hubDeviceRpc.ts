import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HubDeviceChildOptIn,
  HubDeviceOperationInput,
  HubDeviceOperationResult,
} from "./hubDevice.ts";
import {
  HubDeviceRoutesInput,
  HubDeviceRoutesResult,
  HubDeviceRoutesUpdateInput,
} from "./hubDeviceRoutes.ts";
import { GoatHubDeviceVerifyInput, GoatHubDeviceVerifyResult } from "./hubParity.ts";
import { ChildReadyResult, HubDeviceSetupInput } from "./opencodexChildReady.ts";
import { OrchestratorMcpFailure } from "./orchestratorMcpFailure.ts";

/** The hub's device operations; the core RPC group registers them. */
export const HUB_DEVICE_WS_METHODS = {
  hubDeviceVerify: "hub.deviceVerify",
  hubDeviceJoin: "hub.deviceJoin",
  hubDeviceLeave: "hub.deviceLeave",
  hubDeviceRepair: "hub.deviceRepair",
  hubDeviceChildOptIn: "hub.deviceChildOptIn",
  hubDeviceSetup: "hub.device_setup",
  hubDeviceRoutes: "hub.deviceRoutes",
  hubDeviceRoutesUpdate: "hub.deviceRoutesUpdate",
} as const;

const HubDeviceRpcError = Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]);

/** Read-only parity checks for one device, the same as goat_hub_device_verify. */
export const WsHubDeviceVerifyRpc = Rpc.make(HUB_DEVICE_WS_METHODS.hubDeviceVerify, {
  payload: GoatHubDeviceVerifyInput,
  success: GoatHubDeviceVerifyResult,
  error: HubDeviceRpcError,
});

/** The same operations as goat_hub_device_join, _leave and _repair, for a person in a client. */
const hubDeviceOperation = (
  tag:
    | typeof HUB_DEVICE_WS_METHODS.hubDeviceJoin
    | typeof HUB_DEVICE_WS_METHODS.hubDeviceLeave
    | typeof HUB_DEVICE_WS_METHODS.hubDeviceRepair,
) =>
  Rpc.make(tag, {
    payload: HubDeviceOperationInput,
    success: HubDeviceOperationResult,
    error: HubDeviceRpcError,
  });
export const WsHubDeviceJoinRpc = hubDeviceOperation(HUB_DEVICE_WS_METHODS.hubDeviceJoin);
export const WsHubDeviceLeaveRpc = hubDeviceOperation(HUB_DEVICE_WS_METHODS.hubDeviceLeave);
export const WsHubDeviceRepairRpc = hubDeviceOperation(HUB_DEVICE_WS_METHODS.hubDeviceRepair);
/** A person turns an SSH host's OpenCodex Child setup on or off; agents have no equivalent. */
export const WsHubDeviceChildOptInRpc = Rpc.make(HUB_DEVICE_WS_METHODS.hubDeviceChildOptIn, {
  payload: HubDeviceChildOptIn,
  success: HubDeviceChildOptIn,
  error: HubDeviceRpcError,
});
/** Retries or finishes one Child's setup, the same as goat_hub_device_setup. */
export const WsHubDeviceSetupRpc = Rpc.make(HUB_DEVICE_WS_METHODS.hubDeviceSetup, {
  payload: HubDeviceSetupInput,
  success: ChildReadyResult,
  error: HubDeviceRpcError,
});
/** A Remote Link Child's routes on the Home, the same as goat_hub_device_routes. */
export const WsHubDeviceRoutesRpc = Rpc.make(HUB_DEVICE_WS_METHODS.hubDeviceRoutes, {
  payload: HubDeviceRoutesInput,
  success: HubDeviceRoutesResult,
  error: HubDeviceRpcError,
});
/** A person adds, removes or reorders a Child's routes; their action is the approval. */
export const WsHubDeviceRoutesUpdateRpc = Rpc.make(HUB_DEVICE_WS_METHODS.hubDeviceRoutesUpdate, {
  payload: HubDeviceRoutesUpdateInput,
  success: HubDeviceRoutesResult,
  error: HubDeviceRpcError,
});
