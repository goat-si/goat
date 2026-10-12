# GOAT Structure Index

This folder is the maintainer source of truth for the current system shape. Public user workflows
belong in `docs/user/`. Constraints that span components and are hard to rediscover stay in
`docs/internals/`. Open work is recorded in `devlog/`.

Derived from [`manifest.json`](manifest.json) using the layout in [`AGENTS.md`](AGENTS.md). Edit the
manifest, then regenerate this file; do not let the two disagree. There is no `structure:index`
script in the repository.

## Reading order

### Tier 1 — Foundation

What GOAT is, which process owns the workspace, and the invariants nothing may break.

| Doc                          | Scope                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| [`overview.md`](overview.md) | Product boundary, the client-to-effect path, and the invariants index. |

### Tier 2 — Shared packages

Wire schemas and the libraries web, desktop, and mobile share.

| Doc                                      | Scope                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`contracts.md`](contracts.md)           | Effect Schema wire types shared by the server and every client.                                |
| [`client-runtime.md`](client-runtime.md) | Connection, RPC session, and GOAT Bot helpers shared by web and mobile.                        |
| [`shared.md`](shared.md)                 | Subpath helpers for settings merge, worktree homes, mobile identity, and SSH runtime archives. |

### Tier 3 — Server

The process that commits orchestration, runs providers, and reaches other machines.

| Doc                                                              | Scope                                                                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`server.md`](server.md)                                         | Process entry, command commit, orchestration v2, checkpoints, providers, and source control. |
| [`mcp-toolkits.md`](mcp-toolkits.md)                             | The GOAT MCP server, toolkit layout, and which tool names use which prefix.                  |
| [`channels.md`](channels.md)                                     | The channel ledger, Slack and MCP ingress, and the GOAT Bot thread clients render.           |
| [`scheduled-tasks.md`](scheduled-tasks.md)                       | Clock and webhook tasks that launch or send through orchestration services.                  |
| [`ssh.md`](ssh.md)                                               | OpenSSH host discovery, the remote ~/.goat server, and agent browse and launch.              |
| [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md) | Wakes for a launched thread, and durable SSH dispatches that report back.                    |

### Tier 4 — Clients

Web, the Electron shell around it, and the React Native app.

| Doc                        | Scope                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| [`web.md`](web.md)         | The Vite React client, pairing, and the desktop preload bridge it detects. |
| [`desktop.md`](desktop.md) | Electron shell, bundled server, and the packaged data directory.           |
| [`mobile.md`](mobile.md)   | The Expo React Native app, its store identity, and the GOAT Bot screen.    |

### Tier 5 — Local state

Which directory each process writes, and the files under it.

| Doc                                                  | Scope                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`settings-and-storage.md`](settings-and-storage.md) | The ~/.t3 default, the packaged desktop home, the SSH host home, and statev2.sqlite. |

## Which doc describes which source

A source area can be described by more than one doc, because these docs are organised by topic and
the repository is organised by package. Changing an area requires review of every listed document.

| Source path                                                             | Described by                                                                                                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop`                                                          | [`overview.md`](overview.md)<br>[`desktop.md`](desktop.md)                                                                                             |
| `apps/desktop/package.json`                                             | [`desktop.md`](desktop.md)                                                                                                                             |
| `apps/desktop/src/app/DesktopEnvironment.ts`                            | [`desktop.md`](desktop.md)                                                                                                                             |
| `apps/desktop/src/app/DesktopStatePaths.ts`                             | [`settings-and-storage.md`](settings-and-storage.md)                                                                                                   |
| `apps/desktop/src/app/DesktopUserData.ts`                               | [`settings-and-storage.md`](settings-and-storage.md)                                                                                                   |
| `apps/desktop/src/backend/DesktopBackendManager.ts`                     | [`desktop.md`](desktop.md)                                                                                                                             |
| `apps/desktop/src/electron/ElectronProtocol.ts`                         | [`desktop.md`](desktop.md)                                                                                                                             |
| `apps/desktop/src/main.ts`                                              | [`desktop.md`](desktop.md)                                                                                                                             |
| `apps/desktop/src/preload.ts`                                           | [`web.md`](web.md)<br>[`desktop.md`](desktop.md)                                                                                                       |
| `apps/desktop/src/ssh/DesktopSshEnvironment.ts`                         | [`ssh.md`](ssh.md)<br>[`desktop.md`](desktop.md)                                                                                                       |
| `apps/mobile`                                                           | [`overview.md`](overview.md)<br>[`mobile.md`](mobile.md)                                                                                               |
| `apps/mobile/app.config.ts`                                             | [`mobile.md`](mobile.md)                                                                                                                               |
| `apps/mobile/README.md`                                                 | [`mobile.md`](mobile.md)                                                                                                                               |
| `apps/mobile/src/App.tsx`                                               | [`mobile.md`](mobile.md)                                                                                                                               |
| `apps/mobile/src/features/connection/pairing.ts`                        | [`mobile.md`](mobile.md)                                                                                                                               |
| `apps/mobile/src/features/goat-bot/`                                    | [`client-runtime.md`](client-runtime.md)                                                                                                               |
| `apps/mobile/src/features/goat-bot/goatBotHomeMode.ts`                  | [`mobile.md`](mobile.md)                                                                                                                               |
| `apps/mobile/src/features/goat-bot/GoatBotScreen.tsx`                   | [`channels.md`](channels.md)<br>[`mobile.md`](mobile.md)                                                                                               |
| `apps/mobile/src/Stack.tsx`                                             | [`mobile.md`](mobile.md)                                                                                                                               |
| `apps/server/src/bin.ts`                                                | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/binCli.ts`                                             | [`overview.md`](overview.md)<br>[`server.md`](server.md)                                                                                               |
| `apps/server/src/channels/ChannelBotHome.ts`                            | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/ChannelBotRegistry.ts`                        | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/ChannelBotTimeline.ts`                        | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/ChannelDispatcher.ts`                         | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/ChannelGateway.ts`                            | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/ChannelReceptionService.ts`                   | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/slack/SlackChannelAdapter.ts`                 | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/slack/SlackChannelRuntime.ts`                 | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/channels/slack/SlackChannelSettings.live.ts`           | [`channels.md`](channels.md)                                                                                                                           |
| `apps/server/src/checkpointing/CheckpointStore.ts`                      | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/checkpointing/Utils.ts`                                | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/cli/config.ts`                                         | [`settings-and-storage.md`](settings-and-storage.md)                                                                                                   |
| `apps/server/src/cli/server.ts`                                         | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/cli/sshHelper.ts`                                      | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/config.ts`                                             | [`overview.md`](overview.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                                                                   |
| `apps/server/src/device/SshDeviceHost.ts`                               | [`ssh.md`](ssh.md)                                                                                                                                     |
| `apps/server/src/mcp/`                                                  | [`mcp-toolkits.md`](mcp-toolkits.md)                                                                                                                   |
| `apps/server/src/mcp/HostThreadsMcpService.ts`                          | [`mcp-toolkits.md`](mcp-toolkits.md)<br>[`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                               |
| `apps/server/src/mcp/launchWatch.ts`                                    | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                                                                       |
| `apps/server/src/mcp/LaunchWatchService.ts`                             | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                                                                       |
| `apps/server/src/mcp/McpHttpServer.ts`                                  | [`overview.md`](overview.md)<br>[`mcp-toolkits.md`](mcp-toolkits.md)                                                                                   |
| `apps/server/src/mcp/OrchestratorMcpService.ts`                         | [`mcp-toolkits.md`](mcp-toolkits.md)<br>[`scheduled-tasks.md`](scheduled-tasks.md)<br>[`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md) |
| `apps/server/src/mcp/toolkits/orchestrator/tools.ts`                    | [`mcp-toolkits.md`](mcp-toolkits.md)<br>[`scheduled-tasks.md`](scheduled-tasks.md)                                                                     |
| `apps/server/src/mcp/toolkits/preview/tools.ts`                         | [`mcp-toolkits.md`](mcp-toolkits.md)                                                                                                                   |
| `apps/server/src/mcp/toolkits/project/handlers.ts`                      | [`mcp-toolkits.md`](mcp-toolkits.md)<br>[`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                               |
| `apps/server/src/mcp/toolkits/project/tools.ts`                         | [`mcp-toolkits.md`](mcp-toolkits.md)                                                                                                                   |
| `apps/server/src/mcp/toolkits/remoteReport/tools.ts`                    | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                                                                       |
| `apps/server/src/mcp/toolkits/ssh/handlers.ts`                          | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                                                                       |
| `apps/server/src/mcp/toolkits/ssh/tools.ts`                             | [`mcp-toolkits.md`](mcp-toolkits.md)<br>[`ssh.md`](ssh.md)                                                                                             |
| `apps/server/src/orchestration-v2/`                                     | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts`     | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/CheckpointCaptureService.ts`          | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/CheckpointService.ts`                 | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/EffectWorker.ts`                      | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/EventSink.ts`                         | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/Orchestrator.ts`                      | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts`           | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`                      | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/orchestration-v2/ThreadCommandExecutor.ts`             | [`shared.md`](shared.md)<br>[`server.md`](server.md)                                                                                                   |
| `apps/server/src/orchestration-v2/ThreadLaunchService.ts`               | [`mcp-toolkits.md`](mcp-toolkits.md)                                                                                                                   |
| `apps/server/src/orchestration-v2/ThreadManagementService.ts`           | [`server.md`](server.md)<br>[`mcp-toolkits.md`](mcp-toolkits.md)                                                                                       |
| `apps/server/src/orchestration-v2/ThreadMessageIntake.ts`               | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/os-jank.ts`                                            | [`settings-and-storage.md`](settings-and-storage.md)                                                                                                   |
| `apps/server/src/persistence/initializeV2Database.ts`                   | [`settings-and-storage.md`](settings-and-storage.md)                                                                                                   |
| `apps/server/src/persistence/Migrations/062_RemoteReports.ts`           | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                               |
| `apps/server/src/persistence/Migrations/063_RemoteDispatches.ts`        | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                               |
| `apps/server/src/persistence/Migrations/064_ChannelLedger.ts`           | [`channels.md`](channels.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                                                                   |
| `apps/server/src/persistence/Migrations/065_RemoteDispatchQuestions.ts` | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                               |
| `apps/server/src/provider/builtInDrivers.ts`                            | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/provider/Drivers/AntigravityDriver.ts`                 | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/provider/Drivers/ClaudeDriver.ts`                      | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/provider/Drivers/CodexDriver.ts`                       | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/remoteReports/RemoteDispatchCoordinator.ts`            | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                                                                       |
| `apps/server/src/scheduledTasks/Schedule.ts`                            | [`scheduled-tasks.md`](scheduled-tasks.md)                                                                                                             |
| `apps/server/src/scheduledTasks/ScheduledTaskService.ts`                | [`scheduled-tasks.md`](scheduled-tasks.md)                                                                                                             |
| `apps/server/src/scheduledTasks/webhookRoute.ts`                        | [`scheduled-tasks.md`](scheduled-tasks.md)                                                                                                             |
| `apps/server/src/scheduledTasks/webhookVerification.ts`                 | [`scheduled-tasks.md`](scheduled-tasks.md)                                                                                                             |
| `apps/server/src/scheduling/Scheduler.ts`                               | [`scheduled-tasks.md`](scheduled-tasks.md)                                                                                                             |
| `apps/server/src/server.ts`                                             | [`overview.md`](overview.md)<br>[`server.md`](server.md)                                                                                               |
| `apps/server/src/serverSettings.ts`                                     | [`settings-and-storage.md`](settings-and-storage.md)                                                                                                   |
| `apps/server/src/sourceControl/`                                        | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/sourceControl/builtInDrivers.ts`                       | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/sshRemote/remoteBrowse.ts`                             | [`ssh.md`](ssh.md)                                                                                                                                     |
| `apps/server/src/sshRemote/SshRemoteDispatch.ts`                        | [`ssh.md`](ssh.md)                                                                                                                                     |
| `apps/server/src/sshRemote/SshWorkspaceSync.ts`                         | [`ssh.md`](ssh.md)                                                                                                                                     |
| `apps/server/src/vcs/GitVcsDriver.ts`                                   | [`server.md`](server.md)                                                                                                                               |
| `apps/server/src/ws.ts`                                                 | [`overview.md`](overview.md)<br>[`server.md`](server.md)<br>[`scheduled-tasks.md`](scheduled-tasks.md)                                                 |
| `apps/web`                                                              | [`overview.md`](overview.md)<br>[`web.md`](web.md)                                                                                                     |
| `apps/web/package.json`                                                 | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/branding.ts`                                              | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/components/goatBot/`                                      | [`client-runtime.md`](client-runtime.md)<br>[`channels.md`](channels.md)<br>[`web.md`](web.md)                                                         |
| `apps/web/src/components/settings/GoatBotSettings.tsx`                  | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/connection/runtime.ts`                                    | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/env.ts`                                                   | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/environments/primary/auth.ts`                             | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/lib/runtime.ts`                                           | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/routes/_chat.tsx`                                         | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/src/routes/pair.tsx`                                          | [`web.md`](web.md)                                                                                                                                     |
| `apps/web/vite.config.ts`                                               | [`web.md`](web.md)                                                                                                                                     |
| `packages/client-runtime`                                               | [`overview.md`](overview.md)<br>[`client-runtime.md`](client-runtime.md)                                                                               |
| `packages/client-runtime/package.json`                                  | [`client-runtime.md`](client-runtime.md)                                                                                                               |
| `packages/client-runtime/src/goatBot/`                                  | [`client-runtime.md`](client-runtime.md)<br>[`channels.md`](channels.md)<br>[`web.md`](web.md)                                                         |
| `packages/client-runtime/src/goatBot/home.ts`                           | [`client-runtime.md`](client-runtime.md)<br>[`channels.md`](channels.md)                                                                               |
| `packages/client-runtime/src/goatBot/index.ts`                          | [`client-runtime.md`](client-runtime.md)                                                                                                               |
| `packages/client-runtime/src/rpc/session.ts`                            | [`client-runtime.md`](client-runtime.md)<br>[`web.md`](web.md)                                                                                         |
| `packages/contracts`                                                    | [`overview.md`](overview.md)<br>[`contracts.md`](contracts.md)<br>[`server.md`](server.md)                                                             |
| `packages/contracts/package.json`                                       | [`contracts.md`](contracts.md)                                                                                                                         |
| `packages/contracts/src/channelCommon.ts`                               | [`contracts.md`](contracts.md)<br>[`channels.md`](channels.md)                                                                                         |
| `packages/contracts/src/channelGateway.ts`                              | [`contracts.md`](contracts.md)<br>[`mcp-toolkits.md`](mcp-toolkits.md)                                                                                 |
| `packages/contracts/src/index.ts`                                       | [`contracts.md`](contracts.md)                                                                                                                         |
| `packages/contracts/src/ipc.ts`                                         | [`contracts.md`](contracts.md)<br>[`ssh.md`](ssh.md)                                                                                                   |
| `packages/contracts/src/orchestrationV2.ts`                             | [`contracts.md`](contracts.md)                                                                                                                         |
| `packages/contracts/src/remoteReports.ts`                               | [`launch-and-remote-dispatch.md`](launch-and-remote-dispatch.md)                                                                                       |
| `packages/contracts/src/rpc.ts`                                         | [`contracts.md`](contracts.md)                                                                                                                         |
| `packages/contracts/src/settings.ts`                                    | [`contracts.md`](contracts.md)<br>[`channels.md`](channels.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                                 |
| `packages/provider-acp`                                                 | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-acp-registry`                                        | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-acp-registry/src/server/driver.ts`                   | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-core`                                                | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-cursor`                                              | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-cursor/src/server/driver.ts`                         | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-grok`                                                | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-grok/src/server/driver.ts`                           | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-muse`                                                | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-muse/src/server/driver.ts`                           | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-opencode`                                            | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-opencode/src/server/driver.ts`                       | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-pi`                                                  | [`server.md`](server.md)                                                                                                                               |
| `packages/provider-pi/src/server/driver.ts`                             | [`server.md`](server.md)                                                                                                                               |
| `packages/shared`                                                       | [`shared.md`](shared.md)                                                                                                                               |
| `packages/shared/package.json`                                          | [`shared.md`](shared.md)                                                                                                                               |
| `packages/shared/src/cliRelease.ts`                                     | [`shared.md`](shared.md)                                                                                                                               |
| `packages/shared/src/devHome.ts`                                        | [`shared.md`](shared.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                                                                       |
| `packages/shared/src/mobileAppIdentity.ts`                              | [`shared.md`](shared.md)<br>[`mobile.md`](mobile.md)                                                                                                   |
| `packages/shared/src/path.ts`                                           | [`shared.md`](shared.md)                                                                                                                               |
| `packages/shared/src/serverSettings.ts`                                 | [`shared.md`](shared.md)                                                                                                                               |
| `packages/shared/src/sshRuntimeProtocol.ts`                             | [`shared.md`](shared.md)                                                                                                                               |
| `packages/shared/src/themePalettes.ts`                                  | [`shared.md`](shared.md)                                                                                                                               |
| `packages/source-control-azure-devops`                                  | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-bitbucket`                                     | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-core`                                          | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-forgejo`                                       | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-gitcafe`                                       | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-github`                                        | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-gitlab`                                        | [`server.md`](server.md)                                                                                                                               |
| `packages/source-control-testing`                                       | [`server.md`](server.md)                                                                                                                               |
| `packages/ssh`                                                          | [`ssh.md`](ssh.md)<br>[`desktop.md`](desktop.md)                                                                                                       |
| `packages/ssh/package.json`                                             | [`ssh.md`](ssh.md)                                                                                                                                     |
| `packages/ssh/src/auth.ts`                                              | [`ssh.md`](ssh.md)                                                                                                                                     |
| `packages/ssh/src/command.ts`                                           | [`ssh.md`](ssh.md)                                                                                                                                     |
| `packages/ssh/src/config.ts`                                            | [`ssh.md`](ssh.md)                                                                                                                                     |
| `packages/ssh/src/errors.ts`                                            | [`ssh.md`](ssh.md)                                                                                                                                     |
| `packages/ssh/src/tunnel.ts`                                            | [`ssh.md`](ssh.md)<br>[`settings-and-storage.md`](settings-and-storage.md)                                                                             |
| `README.md`                                                             | [`overview.md`](overview.md)                                                                                                                           |
