# MCP toolkits

Agents that are already running inside a provider CLI call back into this server over MCP. The
HTTP server is `layerMcpTransport` in `apps/server/src/mcp/McpHttpServer.ts`: `McpServer.layerHttp`
with `name: "GOAT"`, `path: "/mcp"`, and protocol `McpProtocol.v2025_06_18`. Unauthorized calls
fail with copy that names a GOAT MCP credential.

`McpHttpServer.layer` merges one toolkit layer per area and provides `LaunchWatchService`,
`RemoteReportService`, and `RemoteDispatchCoordinator`. Each toolkit is a `tools.ts` that declares
`Tool.make` entries and a `handlers.ts` that implements them. Handlers call a service. They do not
append orchestration events themselves. That write is the [command commit](server.md#command-commit).

## Toolkits

The directories under `apps/server/src/mcp/toolkits/` are `attachment`, `channel`, `connection`,
`device`, `environment`, `html`, `orchestrator`, `preview`, `previewControls`, `project`,
`pullRequests`, `remoteReport`, `ssh`, `thread`, and `worktree`.

Names are not one prefix.

| Prefix or name | Examples | Defined in |
| --- | --- | --- |
| `goat_*` | `goat_thread_launch`, `goat_project_list`, `goat_thread_send`, `goat_ssh_host_list` | `apps/server/src/mcp/toolkits/project/tools.ts`, `apps/server/src/mcp/toolkits/orchestrator/tools.ts`, `apps/server/src/mcp/toolkits/ssh/tools.ts` |
| unprefixed orchestrator tools | `orchestrator_capabilities`, `delegate_task`, `schedule_task` | `apps/server/src/mcp/toolkits/orchestrator/tools.ts` |
| `channel_*` | `channel_ingest`, `channel_input_get`, `channel_task_get`, `channel_task_list`, `channel_task_report` | `CHANNEL_MCP_TOOL_NAMES` in `packages/contracts/src/channelGateway.ts` |
| `preview_*` | `preview_status`, `preview_snapshot`, `preview_click` | `apps/server/src/mcp/toolkits/preview/tools.ts` |

`schedule_task` calls `ScheduledTaskService` through `apps/server/src/mcp/OrchestratorMcpService.ts`.
`goat_thread_launch` and `goat_ssh_thread_launch` register a launch watch when completion
notifications are left on. Those two paths are [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)
and [`ssh.md`](ssh.md).

## Tool names

The registered names are the `goat_*` forms above, plus the unprefixed and `channel_*` / `preview_*`
tools. Presentation of older `t3_*` tool names, when it exists, is display recovery for history.
Registration uses the current names.

> Decision record: [ADR-0007](decisions/ADR-0007-mcp-tool-names.md)
