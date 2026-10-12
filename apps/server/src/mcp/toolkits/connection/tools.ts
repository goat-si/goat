import {
  EnvironmentId,
  OrchestratorMcpFailure,
  SavedConnection,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

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
  ],
};

const ListTool = Tool.make("goat_connection_list", {
  ...shared,
  description:
    "List the connections saved in the GOAT desktop app on this machine: the environments its sidebar shows, with their routes and who added them. No credentials are returned.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ connections: Schema.Array(SavedConnection) }),
})
  .annotate(Tool.Title, "List saved connections")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const AddSshTool = Tool.make("goat_connection_add_ssh", {
  ...shared,
  description:
    "Save an SSH host in Settings → Connections of the GOAT desktop app on this machine so its threads appear in the sidebar. Key-based SSH only (keys or ssh-agent); a password host fails. An already saved machine (by alias or endpoint) is returned with created:false. A machine saved through another route gains this SSH route with created:false. The first connection may take minutes. Needs a full-access caller. Requires the GOAT desktop app to be running on this machine.",
  parameters: Schema.Struct({
    host: TrimmedNonEmptyString.annotate({
      description: "SSH alias or host from goat_ssh_host_list.",
    }),
    label: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ created: Schema.Boolean, connection: SavedConnection }),
})
  .annotate(Tool.Title, "Save an SSH connection")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const RemoveTool = Tool.make("goat_connection_remove", {
  ...shared,
  description:
    "Remove a saved connection like Settings → Remove: forget pairing, credentials and cached threads on this device, and stop a server GOAT launched over SSH. The local environment and T3 Connect environments are refused.",
  parameters: Schema.Struct({ environmentId: EnvironmentId }),
  success: Schema.Struct({ removed: SavedConnection }),
})
  .annotate(Tool.Title, "Remove a saved connection")
  .annotate(Tool.Destructive, true);

export const ConnectionToolkit = Toolkit.make(ListTool, AddSshTool, RemoveTool);
