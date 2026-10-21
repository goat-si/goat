# Server

`apps/server` is the process that owns the workspace. Provider CLIs, git checkpoints, and project
files run here. Clients talk to it over WebSocket RPC. The [state roots](settings-and-storage.md#state-roots)
contract picks the directory this process uses.

## Process

`apps/server/src/bin.ts` is the executable entry. When it is the process entrypoint it either
serves the ACP MCP stdio bridge or calls `runCli` in `apps/server/src/binCli.ts`. The CLI root is
`Command.make("goat")`. A bare `goat` runs `runDefaultServerCommand` from `apps/server/src/cli/server.ts`,
which resolves config, takes the state directory's `server-owner.lock`
([state roots](settings-and-storage.md#state-roots)), and calls `runServer` in
`apps/server/src/server.ts`. A server under the service launcher waits while another server owns
the directory; any other server fails after a short grace for an owner that is exiting.

`runServer` launches the HTTP layer. `layerHttpServer` binds `NodeHttp.createServer` with the
configured host, port, and websocket options. WebSocket RPC is `GET /ws` in `apps/server/src/ws.ts`.
The method `ORCHESTRATION_V2_WS_METHODS.dispatchCommand` calls `ThreadMessageIntake.dispatchCommand`
in `apps/server/src/orchestration-v2/ThreadMessageIntake.ts`, which calls
`ThreadManagementService.dispatch` unless the thread is a bot thread.

Subcommands on the same binary include `serve`, `pair`, `service`, and `update`. `connect` is
always registered; while `GOAT_CONNECT_ENABLED` is false in `@goat/shared/goatConnect`,
it prints the GOAT Connect coming-soon message and exits 0 without running Connect setup. Remote launch scripts call
`__ssh-helper` (`apps/server/src/cli/sshHelper.ts`). The list is `apps/server/src/binCli.ts`.

`goat service` installs the server as the systemd user unit `goat.service` or the launch agent
`si.goat.service`, rendered by `apps/server/src/cloud/bootService.ts`. A unit under the pre-rename
names (`t3code.service`, `com.t3tools.t3code.service`) that serves the same home is moved to the
new names by a started install or a restart, and put back if the new unit fails to start. A legacy
unit serving another home belongs to another install and is never touched.

## Updates

Self-update admission and requester attribution live in `cloud/selfUpdate.ts` and
`maintenance/MaintenanceAudit.ts`. Boot-service activation closes `RuntimeAdmission`
and requires idle unless explicitly confirmed; its fsynced journal is outside SQLite
rollback. SSH setup records requests through that same journal service.

Compatibility between two GOAT builds comes from the protocol ranges each serves, never from their
release strings. `goat_host_status` reports the ranges every machine serves (`protocol`), and the
machine that fans out judges each reachable remote with `hostCompatibilityOf` in
`packages/shared/src/sshRuntimeProtocol.ts` (`markHostCompatibility` in
`apps/server/src/mcp/hostStatusModel.ts`): `compatible` when its ranges include every protocol
this machine speaks, `incompatible` when they miss one (the message names the side to update), and
`degraded` when it does not report valid ranges. `versionMismatch` only marks a different build;
clients warn from `compatibility`.

> Decision record: [ADR-0019](decisions/ADR-0019-update-compatibility.md)

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

Human handoffs are owned by `apps/server/src/handoffs/Handoffs.ts`. Their safe metadata and actor-labelled
state changes commit through orchestration; sign-in URLs, device codes and continuation arguments
are encrypted separately. Only authorized client sessions can read the human instructions. The legacy secret request
keeps its wire shape and adds handoff metadata; secret values still stay in the one-use server store.

An earlier engine stored an append-only log in SQLite. That tree is gone. v2 is the commit path
above.

> Decision record: [ADR-0001](decisions/ADR-0001-event-sourcing.md)

> Decision record: [ADR-0002](decisions/ADR-0002-orchestration-v2.md)

## Checkpoints

A finished local run enqueues `checkpoint.capture`.
Cloud runs settle directly without a local checkpoint or workspace refresh. `CheckpointCaptureService` in
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

`apps/server/src/opencodex/OpenCodexInventory.ts` reads this machine's OpenCodex through
loopback health/readiness probes and read-only CLI status commands. It defaults existing
installs to adopted ownership and caches discovery for host-status polling. Its optional
`metrics.opencodex` travels through the existing host-status fan-out; older hosts omit it.
Child link records remain Home-owned, so a missing Child link directory is normal.

`BUILT_IN_DRIVERS` in `apps/server/src/provider/builtInDrivers.ts` is the static driver list.
`ProviderInstanceRegistry` walks it when it resolves `providerInstances` from server settings.
Anything missing from the list becomes an unavailable snapshot.

| Driver kind   | Module                                                  |
| ------------- | ------------------------------------------------------- |
| `codex`       | `apps/server/src/provider/Drivers/CodexDriver.ts`       |
| `claudeAgent` | `apps/server/src/provider/Drivers/ClaudeDriver.ts`      |
| `claudeCloud` | `apps/server/src/provider/Drivers/ClaudeCloudDriver.ts` |
| `cursor`      | `packages/provider-cursor/src/server/driver.ts`         |
| `cursorCloud` | `packages/provider-cursor/src/server/cloud/driver.ts`   |
| `grok`        | `packages/provider-grok/src/server/driver.ts`           |
| `opencode`    | `packages/provider-opencode/src/server/driver.ts`       |
| `antigravity` | `apps/server/src/provider/Drivers/AntigravityDriver.ts` |
| `pi`          | `packages/provider-pi/src/server/driver.ts`             |
| `muse`        | `packages/provider-muse/src/server/driver.ts`           |
| `acpRegistry` | `packages/provider-acp-registry/src/server/driver.ts`   |
| `devinCloud`  | `packages/provider-devin-cloud/src/server/driver.ts`    |

`BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2` in
`apps/server/src/orchestration-v2/builtInProviderAdapterDrivers.ts` lists the v2 turn adapters for
codex, claude, cursor, opencode, grok, pi, and `acpRegistry`. Antigravity and Muse attach their v2
adapters on the driver: `makeAntigravityAdapterV2` inside `AntigravityDriver.ts`, and
`makeMuseAdapterV2` inside `packages/provider-muse/src/server/driver.ts`.

`packages/provider-core` holds the driver and adapter-driver interfaces those packages implement.
`packages/provider-acp` is the ACP client stack the ACP drivers sit on. Shared provider behavior
that must not branch through the orchestrator belongs at this boundary.
`packages/provider-devin-cloud` supplies Devin Cloud's transport and lifecycle, with its v2 adapter
attached on the driver.

Cloud execution belongs to the provider adapter, while GOAT owns durable launch
intent, source preflight and observation. The session's execution location bypasses
local worktree/setup/checkpoint paths. Task identity and source remain in the existing
provider-thread projection; the ordinary assistant message retains the result links.
On restart an active cloud task reattaches to its original run and attempt. Shutdown
releases observation without cancelling remote work. Unknown submission outcomes
must never retry a create operation. See the optional `resumeTurn` contract in
`packages/provider-core/src/server/ProviderAdapter.ts` and the read-only source service
in `apps/server/src/orchestration-v2/CloudTaskSourceService.ts`.
`apps/server/src/cloudAgents/CloudAgentService.ts` routes cloud launches to an environment that
holds the provider's sign-in and registers runs other agents started; a registered task's first run
attaches through `resumeTurn` and never submits. See `docs/internals/cloud-credential-holders.md`.
`docs/internals/providers.md` and `docs/internals/adding-a-provider.md` are the contributor
procedures. This page is the inventory.

Codex Home routing belongs to `apps/server/src/provider/OpenCodexRoute.ts`.
It observes OpenCodex on the Codex execution host. OpenCodex owns link keys
and tunnel lifecycle; GOAT's route selection stays on the Codex instance.
The shared status contract is `packages/contracts/src/codexRoute.ts`.

Proposed (not implemented): a hub environment that is the OpenCodex Home for the fleet. Devices
join through OpenCodex Remote Link or Hub mode, driven over GOAT's SSH sessions, and GOAT checks
each device's parity and reads the Home's quota pool.

> Decision record: [ADR-0021](decisions/ADR-0021-goatclaw-hub.md)

## Source control

Pull requests and repository operations go through `apps/server/src/sourceControl/`.
`apps/server/src/sourceControl/builtInDrivers.ts` ships drivers for GitHub, GitLab, Azure DevOps,
Bitbucket, Forgejo, and GitCafe. The packages are `packages/source-control-github`,
`packages/source-control-gitlab`, `packages/source-control-azure-devops`,
`packages/source-control-bitbucket`, `packages/source-control-forgejo`,
`packages/source-control-gitcafe`, and `packages/source-control-core`. A host with no driver in
that list is unsupported. `packages/source-control-testing` holds test doubles and is not a host.
The contracts for linking a thread to a pull request stay in `packages/contracts`.

## Computer use

`apps/server/src/cua/CuaDriver.ts` owns the Cua Driver host lifecycle behind the server setting
`enableCua`, which is off by default. One acquisition is shared by every caller, a crashed or failed
host is retired and replaced on the next acquisition, and disabling stops the host. Standalone
servers start `GOAT_CUA_DRIVER_PATH` when set, otherwise the pinned release that
`apps/server/src/cua/CuaDriverInstallation.ts` downloads, checks against the size and SHA-256 in
`packages/shared/src/cuaDriverRelease.ts`, and publishes under `<base>/tools/cua-driver/<version>`.
Desktop servers send `cuaDriverRequest` on the desktop telemetry control pipe and wait for a
`cuaDriverReport` (`packages/contracts/src/cua.ts`); the Electron main process hosts the driver
([desktop.md](desktop.md#computer-use-host)).

Every host passes the driver's telemetry and update-check opt-outs through its environment
allowlist, and every MCP descriptor the service returns carries all of them. Nothing attaches the
driver to provider sessions yet.

> Decision record: [ADR-0020](decisions/ADR-0020-cua-driver-computer-use.md)

## Services

A WebSocket handler, HTTP route, or MCP tool decodes input, calls one service method, and maps
errors. The service is an Effect `Context.Service`. `ThreadManagementService`,
`ScheduledTaskService`, and `LaunchWatchService` follow that shape. Transport files do not own
the state transition.

> Decision record: [ADR-0003](decisions/ADR-0003-effect-services.md)

## Hub proxy

`apps/server/src/hubProxy/` serves `/hub/nodes/<nodeId>/*`: a client holding `hub:proxy` reaches
a node's API through this server. `apps/server/src/hubProxy/http.ts` authenticates the client with
this server's session, answers auth endpoints itself, proxies an allowlist of read paths and relays
one upstream WebSocket per client socket. `apps/server/src/hubProxy/frames.ts` judges every client
RPC envelope against the client's rights on the node before it is forwarded.
`apps/server/src/hubProxy/HubProxySessions.ts` owns the node sessions the hub holds (issued over
SSH, or enrolled for linked nodes), their per-node generation and the offline shell copy. The node
list comes from `apps/server/src/hubNodes/HubNodes.ts` through
`apps/server/src/hubProxy/HubProxyNodes.ts`. Constraints and the threat model are in
[docs/internals/hub-proxy.md](../docs/internals/hub-proxy.md).
