# MCP toolkits

Agents that are already running inside a provider CLI call back into this server over MCP. The
HTTP server is `layerMcpTransport` in `apps/server/src/mcp/McpHttpServer.ts`: `McpServer.layerHttp`
with `name: "GOAT"`, `path: "/mcp"`, and protocol `McpProtocol.v2025_06_18`. Unauthorized calls
fail with copy that names a GOAT MCP credential.

`McpHttpServer.layer` merges one toolkit layer per area and provides `RemoteReportService` and
`ThreadResultService`. `apps/server/src/server.ts` provides `LaunchWatchService` and
`RemoteDispatchCoordinator` once for these tools and the remote-launch catalog. Each toolkit is a `tools.ts` that declares
`Tool.make` entries and a `handlers.ts` that implements them. Handlers call a service. They do not
append orchestration events themselves. That write is the [command commit](server.md#command-commit).

## Toolkits

The directories under `apps/server/src/mcp/toolkits/` are `attachment`, `channel`, `connection`,
`device`, `environment`, `hostStatus`, `html`, `memory`, `memoryAdministration`, `orchestrator`, `preview`, `previewControls`, `project`,
`provider`, `pullRequests`, `remoteReport`, `ssh`, `thread`, and `worktree`. `provider` is
composed beside `McpHttpServer.layer` in `apps/server/src/server.ts`, which provides
`ProviderDiagnosisService` from the provider registry and host; `goat provider diagnose` runs the
same checks in-process (`apps/server/src/provider/ProviderDiagnosis.ts`).

Tool names, descriptions, schema references and discovery metadata live in
[`agentSurface/registry.ts`](../packages/contracts/src/agentSurface/registry.ts). Each entry has
an explicit `resource.verb` path and retains its current MCP name; this does not change `tools/list`
or introduce callable aliases. Schemas remain with their owning toolkit or contracts module.

`McpToolAccess` declarations carry the effect class. Registration derives the read-only and
destructive hints from those declarations, overriding presentation metadata. The catalog test
compares the registry against the production registration layers, including the three image tools
and the separately composed memory tools, and checks that published strict inputs reject extra keys.

`schedule_task` calls `ScheduledTaskService` through `apps/server/src/mcp/OrchestratorMcpService.ts`.
`goat_thread_launch` and `goat_ssh_thread_launch` register a launch watch when completion
notifications are left on; a launch from outside any thread is watched only when the completion
webhook takes it. Those two paths are [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)
and [`ssh.md`](ssh.md).

`goat_thread_send` from an agent in another thread is delivered like steering, whichever mode the
caller named except `restart`. `OrchestratorMcpService` passes the call through
`threadSendMode` in `apps/server/src/orchestration-v2/ThreadManagementService.ts`, which returns
`steer_when_ready` for that case and for every `auto` send. The message joins a running turn,
waits for a turn that is still starting, or starts an idle thread. When a child's latest task is
a finished review and no task is active, it refuses new agent follow-ups; start a new review
round with `delegate_task`. Retrying an already delivered send returns its existing result.
A provider that cannot steer,
a turn that is already finishing, and the slash commands `/compact`, `/logout`, and `/goal` take
it as the next turn. A thread sending to itself, and a client that is not inside a GOAT thread,
keep an explicit `queue` or `steer`. A send to another host rewrites those two modes to `auto`
in `apps/server/src/mcp/HostThreadsMcpService.ts`, because the remote sees an outside client and
`auto` there is `steer_when_ready`.

A `goat_thread_launch` that asks for a new worktree calls `ThreadLaunchService.checkWorktreeBase`
before a thread exists (`apps/server/src/mcp/toolkits/project/handlers.ts`).
`ThreadLaunchBranchError` in `apps/server/src/orchestration-v2/ThreadLaunchService.ts` refuses a
branch that already exists. When that branch is already checked out, the error names the checkout.
No thread is created.

## Tool names

The registered names include `goat_*` forms, unprefixed names, and `channel_*`, `preview_*`,
`device_*`, `html_*`, and `memory_*` tools. Presentation of older `t3_*` tool names, when it exists, is display recovery for history.
Registration uses the current names.

> Decision record: [ADR-0007](decisions/ADR-0007-mcp-tool-names.md)
