# Server

`apps/server` is the process that owns the workspace. Provider CLIs, git checkpoints, and project
files run here. Clients talk to it over WebSocket RPC. The [state roots](settings-and-storage.md#state-roots)
contract picks the directory this process uses.

## Process

`apps/server/src/bin.ts` is the executable entry. When it is the process entrypoint it either
serves the ACP MCP stdio bridge or calls `runCli` in `apps/server/src/binCli.ts`. The CLI root is
`Command.make("goat")`. A bare `goat` runs `runDefaultServerCommand` from `apps/server/src/cli/server.ts`,
which resolves config and calls `runServer` in `apps/server/src/server.ts`.

`runServer` launches the HTTP layer. `layerHttpServer` binds `NodeHttp.createServer` with the
configured host, port, and websocket options. WebSocket RPC is `GET /ws` in `apps/server/src/ws.ts`.
The method `ORCHESTRATION_V2_WS_METHODS.dispatchCommand` calls `ThreadMessageIntake.dispatchCommand`
in `apps/server/src/orchestration-v2/ThreadMessageIntake.ts`, which calls
`ThreadManagementService.dispatch` unless the thread is a bot thread.

Subcommands on the same binary include `serve`, `pair`, `service`, and `update`. `connect` is
registered when the build has T3 Connect public configuration. Remote launch scripts call
`__ssh-helper` (`apps/server/src/cli/sshHelper.ts`). The list is `apps/server/src/binCli.ts`.

## Command commit

`ThreadManagementService.dispatch` in `apps/server/src/orchestration-v2/ThreadManagementService.ts`
calls `orchestrator.dispatch`. `dispatchWithReceipt` in `apps/server/src/orchestration-v2/Orchestrator.ts`
holds `ThreadCommandExecutor` for that `ThreadId` while it plans and commits. The lock is a
`KeyedLock` from `apps/server/src/orchestration-v2/ThreadCommandExecutor.ts`.

`dispatchWithReceipt` in `apps/server/src/orchestration-v2/Orchestrator.ts` plans the events and
the outbox effects, then `EventSink.commitCommand` persists them. In
`apps/server/src/orchestration-v2/EventSink.ts`, `commitThenPublish` runs the write inside
`sql.withTransaction`:

1. `commandReceipts.insertIfAbsent` reserves the command id. A duplicate returns the existing
   receipt and does not append again.
2. `eventStore.append` writes the events.
3. `applyStoredEvents` updates projections, including `orchestration_v2_projection_metadata`.
4. `effectOutbox.enqueue` writes the effects.
5. `commandReceipts.upsert` stores the accepted receipt at the resulting sequence.

Publish, and the signal that effects are available, run in the `publish` callback after the
transaction. A command acknowledgement means the intent committed. It does not mean the provider
process finished.

Provider turns and checkpoint capture are outbox effect types. `OrchestrationEffectWorkerV2` in
`apps/server/src/orchestration-v2/EffectWorker.ts` claims those rows and dispatches
`provider-turn.start` and `checkpoint.capture`. The worker feeds results back in as later commands.

Checkpoint restore is the planning path that does read the filesystem. Before committing a restore
with `restoreFiles !== false`, the orchestrator calls `isCheckpointRestoreIsolated` with
`FileSystem` and refuses a restore that is not isolated. That read decides whether the command is
legal. It is not the git write. The write stays on the `checkpoint.capture` effect.

## Orchestration

The live engine is `apps/server/src/orchestration-v2/`. `apps/server/src/orchestration-v2/runtimeLayer.ts`
builds `EventSink`, `ProjectionStore`, and `EffectOutbox`. Adapters translate a provider's native protocol into
orchestration events. The registry that returns an adapter for an instance is
`ProviderAdapterRegistryV2` in `apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts`.

An earlier engine stored an append-only log in SQLite. That tree is gone. v2 is the commit path
above.

> Decision record: [ADR-0001](decisions/ADR-0001-event-sourcing.md)

> Decision record: [ADR-0002](decisions/ADR-0002-orchestration-v2.md)

## Checkpoints

A finished run enqueues `checkpoint.capture`. `CheckpointCaptureService` in
`apps/server/src/orchestration-v2/CheckpointCaptureService.ts` calls `CheckpointService.capture`,
then commits a `checkpoint.captured` event through the same sink.

`CHECKPOINT_REFS_PREFIX` in `apps/server/src/orchestration-v2/CheckpointService.ts` is
`refs/t3/orchestration-v2/checkpoints`. `apps/server/src/checkpointing/CheckpointStore.ts` captures
a hidden git ref through the VCS driver. `apps/server/src/vcs/GitVcsDriver.ts` implements
`captureCheckpoint` as `captureTree` at that ref. The legacy helper
`checkpointRefForThreadTurn` in `apps/server/src/checkpointing/Utils.ts` still uses
`refs/t3/checkpoints`.

The ref is how the app diffs a turn and restores the tree. It is not a branch the user is asked
to check out.

## Providers

`BUILT_IN_DRIVERS` in `apps/server/src/provider/builtInDrivers.ts` is the static driver list.
`ProviderInstanceRegistry` walks it when it resolves `providerInstances` from server settings.
Anything missing from the list becomes an unavailable snapshot.

| Driver kind   | Module                                                  |
| ------------- | ------------------------------------------------------- |
| `codex`       | `apps/server/src/provider/Drivers/CodexDriver.ts`       |
| `claudeAgent` | `apps/server/src/provider/Drivers/ClaudeDriver.ts`      |
| `cursor`      | `packages/provider-cursor/src/server/driver.ts`         |
| `grok`        | `packages/provider-grok/src/server/driver.ts`           |
| `opencode`    | `packages/provider-opencode/src/server/driver.ts`       |
| `antigravity` | `apps/server/src/provider/Drivers/AntigravityDriver.ts` |
| `pi`          | `packages/provider-pi/src/server/driver.ts`             |
| `muse`        | `packages/provider-muse/src/server/driver.ts`           |
| `acpRegistry` | `packages/provider-acp-registry/src/server/driver.ts`   |

`BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2` in
`apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts` lists the v2 turn adapters for
codex, claude, cursor, opencode, grok, pi, and `acpRegistry`. Antigravity and Muse attach their v2
adapters on the driver: `makeAntigravityAdapterV2` inside `AntigravityDriver.ts`, and
`makeMuseAdapterV2` inside `packages/provider-muse/src/server/driver.ts`.

`packages/provider-core` holds the driver and adapter-driver interfaces those packages implement.
`packages/provider-acp` is the ACP client stack the ACP drivers sit on. Shared provider behavior
that must not branch through the orchestrator belongs at this boundary.
`docs/internals/providers.md` and `docs/internals/adding-a-provider.md` are the contributor
procedures. This page is the inventory.

## Source control

Pull requests and repository operations go through `apps/server/src/sourceControl/`.
`apps/server/src/sourceControl/builtInDrivers.ts` ships drivers for GitHub, GitLab, Azure DevOps,
Bitbucket, Forgejo, and GitCafe. The packages are `packages/source-control-github`,
`packages/source-control-gitlab`, `packages/source-control-azure-devops`,
`packages/source-control-bitbucket`, `packages/source-control-forgejo`,
`packages/source-control-gitcafe`, and `packages/source-control-core`. A host with no driver in
that list is unsupported. `packages/source-control-testing` holds test doubles and is not a host.
The contracts for linking a thread to a pull request stay in `packages/contracts`.

## Services

A WebSocket handler, HTTP route, or MCP tool decodes input, calls one service method, and maps
errors. The service is an Effect `Context.Service`. `ThreadManagementService`,
`ScheduledTaskService`, and `LaunchWatchService` follow that shape. Transport files do not own
the state transition.

> Decision record: [ADR-0003](decisions/ADR-0003-effect-services.md)
