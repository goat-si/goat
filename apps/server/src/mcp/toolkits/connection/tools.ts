import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  EnvironmentId,
  HubNode,
  HubNodeId,
  HubNodeNotice,
  OrchestratorMcpFailure,
  SavedConnection,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HubNodes from "../../../hubNodes/HubNodes.ts";
import * as ConnectionCatalogBroker from "../../../connections/ConnectionCatalogBroker.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ConnectionCatalogBroker.ConnectionCatalogBroker,
    HubNodes.HubNodes,
  ],
};

const DesktopCatalog = Schema.Literals(["saved", "not_attached", "failed"]);

const ListTool = Tool.make(agentSurfaceRegistry["connection.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["connection.list"].description,
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    connections: Schema.Array(SavedConnection),
    nodes: Schema.Array(HubNode),
    notices: Schema.Array(HubNodeNotice),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["connection.list"]));

const AddSshTool = Tool.make(agentSurfaceRegistry["connection.add_ssh"].name, {
  ...shared,
  description: agentSurfaceRegistry["connection.add_ssh"].description,
  dependencies: [...shared.dependencies, SshDeviceAdd.SshDeviceAdd],
  parameters: SshDeviceAdd.SshDeviceAddInput,
  success: Schema.toCodecJson(SshDeviceAdd.SshDeviceAddResult),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["connection.add_ssh"]));

const RemoveTool = Tool.make(agentSurfaceRegistry["connection.remove"].name, {
  ...shared,
  description: agentSurfaceRegistry["connection.remove"].description,
  parameters: Schema.Struct({
    nodeId: Schema.optionalKey(HubNodeId),
    environmentId: Schema.optionalKey(EnvironmentId),
  }).check(
    Schema.makeFilter(
      (input) =>
        (input.nodeId === undefined) !== (input.environmentId === undefined) ||
        "Provide exactly one of nodeId or environmentId.",
    ),
  ),
  success: Schema.Struct({
    node: HubNode,
    removed: Schema.optionalKey(SavedConnection),
    desktopCatalog: DesktopCatalog,
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["connection.remove"]));

export const ConnectionToolkit = Toolkit.make(ListTool, AddSshTool, RemoveTool);
