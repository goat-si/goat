import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HubNodesAddInput,
  HubNodesAddResult,
  HubNodesCheckInput,
  HubNodesDismissNoticeInput,
  HubNodesDismissNoticeResult,
  HubNodesError,
  HubNodesImportInput,
  HubNodesImportResult,
  HubNodesListInput,
  HubNodesRemoveInput,
  HubNodesRemoveResult,
  HubNodesSnapshot,
  HubNodesSubscribeInput,
} from "./hubNodes.ts";

export const HUB_NODES_WS_METHODS = {
  hubNodesList: "hub.nodes.list",
  hubNodesSubscribe: "hub.nodes.subscribe",
  hubNodesAdd: "hub.nodes.add",
  hubNodesRemove: "hub.nodes.remove",
  hubNodesCheck: "hub.nodes.check",
  hubNodesImport: "hub.nodes.import",
  hubNodesDismissNotice: "hub.nodes.dismissNotice",
} as const;

const HubNodesRpcError = Schema.Union([HubNodesError, EnvironmentAuthorizationError]);
const WsHubNodesListRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesList, {
  payload: HubNodesListInput,
  success: HubNodesSnapshot,
  error: HubNodesRpcError,
});
/** The current node list, then a new one after every change. */
const WsHubNodesSubscribeRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesSubscribe, {
  payload: HubNodesSubscribeInput,
  success: HubNodesSnapshot,
  error: HubNodesRpcError,
  stream: true,
});
const WsHubNodesAddRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesAdd, {
  payload: HubNodesAddInput,
  success: HubNodesAddResult,
  error: HubNodesRpcError,
});
const WsHubNodesRemoveRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesRemove, {
  payload: HubNodesRemoveInput,
  success: HubNodesRemoveResult,
  error: HubNodesRpcError,
});
/** Never wakes or extends a cloud machine. */
const WsHubNodesCheckRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesCheck, {
  payload: HubNodesCheckInput,
  success: HubNodesSnapshot,
  error: HubNodesRpcError,
});
const WsHubNodesImportRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesImport, {
  payload: HubNodesImportInput,
  success: HubNodesImportResult,
  error: HubNodesRpcError,
});
const WsHubNodesDismissNoticeRpc = Rpc.make(HUB_NODES_WS_METHODS.hubNodesDismissNotice, {
  payload: HubNodesDismissNoticeInput,
  success: HubNodesDismissNoticeResult,
  error: HubNodesRpcError,
});

export const HubNodesRpcs = RpcGroup.make(
  WsHubNodesListRpc,
  WsHubNodesSubscribeRpc,
  WsHubNodesAddRpc,
  WsHubNodesRemoveRpc,
  WsHubNodesCheckRpc,
  WsHubNodesImportRpc,
  WsHubNodesDismissNoticeRpc,
);
