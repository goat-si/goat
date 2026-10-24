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

Automatic updates have one policy (`cloud/autoUpdatePolicy.ts`: channel, strictly newer, last
failed target, staged rollout) and one scheduler (`cloud/autoUpdate.ts`) with two activation
paths. A `goat service` server uses the launcher trial. A client-launched SSH runtime
(`cloud/sshRuntimeAutoUpdate.ts`) runs the client's owning launch script on its own host, which
drains it and hands over to the ADR-0013 supervisor; the supervisor's `last-replacement.json` in
`~/.goat/ssh-launch/runtime` is its failed-target record. The same service arbitrates drain
requests that clients mark `automatic`, so shared runtimes only move forward on their channel.

Compatibility between two GOAT builds comes from the protocol ranges each serves, never from their
release strings. `goat_host_status` and `goat_provider_host_matrix` report the ranges every
machine serves (`protocol`), and the machine that fans out judges each reachable remote with
`hostCompatibilityOf` in `packages/shared/src/sshRuntimeProtocol.ts` (`judgeRemoteHost` in
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
`refs/goat/orchestration-v2/checkpoints` (with legacy `refs/t3/orchestration-v2/checkpoints` readers). `apps/server/src/checkpointing/CheckpointStore.ts` captures
a hidden git ref through the VCS driver. `apps/server/src/vcs/GitVcsDriver.ts` implements
`captureCheckpoint` as `captureTree` at that ref. The legacy helper
`checkpointRefForThreadTurn` in `apps/server/src/checkpointing/Utils.ts` still uses
`refs/goat/checkpoints`; old `refs/t3/checkpoints` remain readable.

The ref is how the app diffs a turn and restores the tree. It is not a branch the user is asked
to check out.

## Providers

`apps/server/src/opencodex/OpenCodexInventory.ts` reads this machine's OpenCodex through
loopback health/readiness probes and read-only CLI status commands. It defaults existing
installs to adopted ownership and caches discovery for host-status polling. Its optional
`metrics.opencodex` travels through the existing host-status fan-out; older hosts omit it.
Child link records remain Home-owned, so a missing Child link directory is normal.

`apps/server/src/hub/HubParity.ts` verifies a device against this machine's Home through
the host-status SSH read path. Explicit verification gathers fresh, non-billed evidence;
ordinary host polling returns the last verdict. Missing evidence remains unproven, except
unavailable apply timing, which is skipped. While `hub.enabled` is on, the shared Scheduler
checks Home links every 30 minutes; verification never repairs a device.

`apps/server/src/hub/HubDown.ts` is the hub-down policy for goal work on this machine. When this
device's OpenCodex is linked to a Home that does not answer the relayed models request, the goal
controller pauses actions that would start provider work (goal condition `Blocked`, reason
`HubUnreachable`) and leaves running turns alone. It hops to the device's own sign-in only when
`hub.devices.local.localFallback` is on and the Home granted the device `localFallback` (OCX-11)
before the outage; an OpenCodex that never stated it counts as not granted. One decision item asks
to wait or move the work, and is withdrawn when the Home answers. GOAT never switches the hub or
changes OpenCodex settings, and a machine with `hub.enabled` takes no goal placements.

`apps/server/src/hub/HubMembership.ts` joins, removes and repairs Remote Link Children by
running OpenCodex's own commands: `ocx link …` on this Home and device commands through
`SshRemoteDispatch.runHostScript`, all behind the `HubOcx` seam. OpenCodex moves link keys
itself; GOAT only passes GOAT's pinned host-key fingerprint as `--expect-fingerprint`. A
missing or different pin, a non-owner join or leave, and re-link (ladder step 4) become
owner-required decision items whose context binds the action, alias and key. An approval is
consumed by its `started` row in `audit_events`, which records every membership change.
Leave and re-link clean up the device before the Home (disconnect, restart, standalone
`/healthz`), then force-revoke: the Home's own revoke runs a remote disconnect whose failure
restarts the tunnel. A device that cannot be cleaned up keeps its link until a person decides.

`apps/server/src/opencodex/OpenCodexChildBootstrap.ts` makes a cloud machine this hub created into
its Child at provision time. `CloudMachineService.onReady` fires after each real readying (the
Boat SSH entry is written), and the bootstrap forks one job per alias: install this Home's
OpenCodex release with a user-prefix npm install, start it (`ocx service`, else `ocx start`),
then `HubMembership.joinProvisioned`, which links only when OpenCodex offers GOAT's own pin. It
runs only while `hub.enabled`, skips a recorded Child, waits 10 minutes before retrying a
blocked machine, and never touches SSH hosts a person added. Outcomes persist per alias in the
state directory and reach `goat_host_status` as the host entry's `opencodexChild`.

`apps/server/src/hub/OpenCodexManagedUpdate.ts` moves GOAT-managed OpenCodex installs to the newest
release on OpenCodex's `latest` channel under ADR-0019's rules: staged bucket, idle (subagents
included) before every step, health then parity after each step, 10-minute probation checked every
minute, rollback, and no retry of a rolled-back target. The hub machine (`hub.enabled` and
`goatclaw.enabled`) whose OpenCodex is a Home or standalone coordinates; a Child never moves on its
own. The pure planner in `opencodexUpdatePlan.ts` keeps a Child from running ahead of its Home and
holds the Home until every Child can follow in the same window, because OpenCodex does not yet
publish which Child versions a Home serves (OCX-8). A member whose service status is unknown
(OCX-10), or whose `/healthz` reports no pid or uptime, does not move. Drift alone moves nothing, and adopted
installs only get advisories. Every member a window restarts, and every member a rollback restores, must hold turn admission
(and show no running thread, subagent or in-flight request) through its install and health check; GOAT can hold only its own (`RuntimeAdmission`), so a window that would
restart another host waits as `admission-unsupported`. Pair windows therefore need a host
admission hold before they run. The open window lives in `opencodex-update.json` in the state directory: probation
survives a GOAT restart, acceptance is one write, and a restore that cannot be proven (version, role,
P3, then pair parity) keeps the window open and is retried, Children first, before anything else
moves. Its status rides on this
machine's `goat_host_status` entry.

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
allowlist, and every MCP descriptor the service returns carries all of them.

`apps/server/src/cua/ComputerUseAttachment.ts` is the one decision for whether a provider session
gets the driver. `ProviderSessionManager` asks it on every MCP prepare, so every turn, and stores
the answer as `cuaDriver` on the thread's `McpProviderSessionConfig`. Plan turns, read-only
sandboxes and providers that do not run on this host get nothing, and those threads never start the
driver. Adapters attach `cuaDriver` as a stdio MCP server named `cua-driver` and add the
`<computer_use>` instructions (`packages/provider-core/src/server/runtimeInstructions.ts`) only
when the provider actually has it. Which adapters attach, and when a change reaches a live session,
is in ADR-0020.

`server.checkComputerUse` reports the host's platform, whether a driver is running, why the last
start failed, whether a Linux host runs Wayland, and whether the host has a screen the driver can
use (`apps/server/src/cua/CuaDisplayCapability.ts`). Settings on any client and the desktop's
one-time prompt read it; `goat_host_status` and `goat_provider_host_matrix` carry the same
answer per host as `computerUse`. Turning `enableCua` on where the screen is unusable fails, and
every driver start checks the screen again. A desktop that stops its driver on its own (`cuaDriverReport` with
`stopped`) is restarting it, such as after new macOS grants, so that stop is not a failure.

Both hosts start the driver in standard mode under the capability manifest from
`packages/shared/src/cuaDriverManifest.ts`. Turns nobody directs (GOAT Bot, channel tasks,
scheduled and webhook runs, and what they launch; `ComputerUseOrigin.ts`) get the driver only
while their thread holds a lease: an approved `computer_use.grant` handoff before its expiry
(`ComputerUseLeases.ts`), requested with `goat_computer_use_request` (`ComputerUseRequests.ts`).
A grant may name apps, and interactive turns act only on apps a grant names. Every attached
provider runs the `cua-lease-proxy` subcommand (`ComputerUseLeaseProxy.ts`) instead of
`cua-driver mcp`, under a per-thread control from `ComputerUseLeases`; it follows the control over
`/api/computer-use/lease` (`ComputerUseLeaseRoute.ts`), checks each call's app
(`ComputerUseScope.ts`), and kills its driver child on Stop, the `computerUse.stopAll` kill switch,
expiry, or a pause for a person's input until `computerUse.resume` (`ComputerUseRpcHandlers.ts`).

> Decision record: [ADR-0022](decisions/ADR-0022-cua-driver-computer-use.md)

`apps/server/src/preview/PreviewSessions.ts` lists what agents drive on this host as one
`PreviewSession` shape (`packages/contracts/src/previewSession.ts`), whether a server browser tab
or a computer use control, over `previewSessions.subscribe`, and applies a person's controls
(`previewSessions.control`: takeover, hand back, stop, stop all). A browser tab goes private while
a password, one-time code or passkey prompt has focus (`PreviewPrivateMode.ts`): its
`SessionControl` refuses agent actions and observation, and only its controlling viewer and no
recording get frames.

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
