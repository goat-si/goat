import { GoatHostStatusInput, GoatHostStatusResult, OrchestratorMcpFailure } from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HostStatusTool = Tool.make("goat_host_status", {
  description:
    "Read host status for this machine and every SSH host this process is connected to: GOAT version, CPU, memory, load average, disk free space, running/waiting/queued thread counts, and cached provider quota. Pass host (an SSH alias from goat_ssh_host_list) for one other machine. Pass local:true for this machine only. Reaching another machine needs a caller allowed to use this machine's SSH keys. An unreachable host keeps its last successful sample. A remote GOAT that does not offer this tool is reported as unsupported. versionMismatch:true marks a reachable host running a different GOAT version than this machine; its message says which.",
  parameters: GoatHostStatusInput,
  success: GoatHostStatusResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HostStatusMcpService.HostStatusMcpService,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const HostStatusToolkit = Toolkit.make(HostStatusTool);
