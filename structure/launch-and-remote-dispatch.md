# Launch watches and remote dispatch

Two mechanisms tell a launcher thread what happened to work it started somewhere else. A launch
watch follows runs. A remote dispatch is the durable row for work that was sent to another host,
plus the reports that host sends back. Both end in a [command commit](server.md#command-commit)
on the launcher's server when they have something to say. Neither one runs the provider itself.

## Launch watches

A launch watch is a launcher thread's request to hear about another thread. The module comment on
`apps/server/src/mcp/launchWatch.ts` defines that, and keeps the wake messages free of I/O.
`LaunchWatchService` in `apps/server/src/mcp/LaunchWatchService.ts` stores the watches and follows
them.

The file is `thread-launch-watches.json` (`LAUNCH_WATCH_FILE`) under the server state directory.
Launcherless watches live beside it in `thread-launch-watches-launcherless.json`
(`LAUNCHERLESS_WATCH_FILE`), because servers from before them require a launcher on every watch and
would set the whole shared file aside. Loading moves any launcherless watch an earlier build left in
the shared file. `register`, `rearm`, `unwatch`, and `list` are the service methods.

`goat_thread_launch` (`apps/server/src/mcp/toolkits/project/handlers.ts`) and
`goat_ssh_thread_launch` (`apps/server/src/mcp/toolkits/ssh/handlers.ts`) register a watch when
`notifyOnCompletion` is not false. `HostThreadsMcpService` in
`apps/server/src/mcp/HostThreadsMcpService.ts` re-arms a watch after `goat_thread_send`. A send
from another thread joins the target's turn the way [`mcp-toolkits.md`](mcp-toolkits.md) describes.
The re-arm follows the run that send started or joined. It does not change that delivery.

The follower reads local projections, or long-polls through `SshRemoteDispatch` when the thread is
remote. `deliver` dispatches `message.dispatch` onto `watch.launcherThreadId`. A finished run, a
question the thread is waiting on, and a host that stays unreachable each produce one wake.
With a report attached, a settled wake also goes to `CompletionWebhook` in
`apps/server/src/mcp/completionWebhook.ts`. It posts to the watch's `webhookTarget` when the
launch chose one (a named `completionWebhook.targets` entry, or an inline URL whose signing secret
sits in the secret store under the name the watch keeps), else to `completionWebhook.url` when the
launch opted in. Launch handlers resolve the target through `LaunchWatchService.resolveRoute` before
creating the thread, so a bad target refuses the launch. The service deletes an inline secret once no
saved watch refers to it, and the handler releases it when the launch records no watch.

A launch from an MCP client outside any thread has no launcher to wake. `watchExternal` gives it a
launcherless watch only when the completion webhook takes it: the webhook is on and the launch
chose a target or passed `notifyWebhook: true`, or `completionWebhook.externalLaunches` is set. Otherwise it records
nothing, as before. Such a watch has `launcherThreadId: null` and stores the client's runtime
mode ceiling in `ceiling`, so its remote reads never go above what that client was approved for.
Its reports go only to the webhook, with `launcherThreadId: null` in the payload. Once its run is
reported it stays dormant, and a `goat_thread_send` from outside any thread re-arms it, so follow-up
runs reach the webhook too. It is deleted when the thread is gone. No thread can unwatch it, so it is
also dropped while a run is still owed once the webhook would no longer post its reports, or seven
days after it was last armed.
`listRemote` leaves it out. `goat_thread_launch` skips a launch that another machine's GOAT forwarded
(`launchedBy` or `report` set), because the dispatching machine watches that launch itself.
`SshRemoteDispatch` also forwards `notifyOnCompletion: false` to a remote that declares it, so an
outside client's SSH launch, which carries neither, is not watched a second time there.

A send queued behind a starting turn may later join it, ending its own run as cancelled. The local
wait follows it into the joined run, and the follower reports that run under its own id, once.

> Decision record: [ADR-0009](decisions/ADR-0009-launch-watches.md)

## Remote dispatch

`RemoteDispatchCoordinator` in `apps/server/src/remoteReports/RemoteDispatchCoordinator.ts` inserts
a row in `remote_dispatches` and then calls `SshRemoteDispatch.launchThread`. Migration
`apps/server/src/persistence/Migrations/070_RemoteDispatches.ts` creates that table. Reports use
`apps/server/src/persistence/Migrations/069_RemoteReports.ts` and `RemoteReportService`.
`apps/server/src/persistence/Migrations/072_RemoteDispatchQuestions.ts` adds
`pending_request_ids`, a JSON array of the launched run's open question ids. The coordinator
writes that column from the host's observed `pendingRequestIds` before it announces questions.
When delivery is `wake` and the remote thread id is set, it dispatches one notice per question
onto the origin thread. The same ids are `pendingRequestIds` on `RemoteDispatchView` in
`packages/contracts/src/remoteReports.ts`. A finished run stores an empty list.

Two callers launch this way:

- `goat_ssh_thread_launch`, when the MCP caller has a thread scope, calls `coordinator.launch`
  with `kind: "thread"`. Without a thread scope it calls `SshRemoteDispatch.launchThread` directly.
- `delegate_task` with `target.host` and a remote cwd calls `coordinator.launch` with
  `kind: "task"` from `apps/server/src/mcp/OrchestratorMcpService.ts`.

The remote agent reports with `goat_origin_report` (`apps/server/src/mcp/toolkits/remoteReport/tools.ts`).
The origin reads those reports over the SSH session it already holds. The public view is
`RemoteDispatchView` in `packages/contracts/src/remoteReports.ts`.

Delivery mode decides who wakes. Launch-watch wakes and origin reports are different messages.
A watch fires when a followed run ends. A report is the remote thread speaking back through the
origin binding.

### Relaying sends

A thread launched over SSH names hosts as its origin knows them. When its `goat_thread_send`
names a host its own machine cannot resolve, `HostThreadsMcpService` hands the send back to the
origin instead of failing, but only when the origin declared `relaySend` in the report binding at
launch. The coordinator declares it for `kind: "thread"` dispatches only, so delegated tasks and
older origins, which never declare it, keep the error that names the origin and suggests
`goat_origin_report`. Every other host tool keeps that error too. The remote caller must still be
a live thread in default interaction mode. Migration
`apps/server/src/persistence/Migrations/074_RemoteReportRelay.ts` stores the flag on the binding
and the send on its report row, which travels as `RemoteReport.relay` and answers the agent with
`delivery: "relayed"`. A retry with the same `clientRequestId` returns the same report, even
after the origin collected it. Report retention never prunes a relay the origin has not collected;
instead, a thread with 50 uncollected relays is refused another one.

The origin acts on it in `RemoteDispatchCoordinator.importBatch`, and only for a dispatch whose
own `relay_send` column records that it offered relaying; rows from before that column refuse. It
sends as the launcher thread: that thread must be live and in default interaction mode, and its
runtime mode is the ceiling the target host enforces, as for the launcher's own cross-machine
sends. The target dedupes `clientRequestId` per SSH session, and a restart replaces the session,
so `relay_attempted` records each relay before it is sent. A relay replayed after a restart is
reported as possibly delivered and is not sent again. A delivered send re-arms the launcher's
watch on the target and resumes any dispatch that follows that thread. The outcome goes to the
launcher's inbox, with remote identifiers escaped. A send that was refused or may not have
arrived quotes the reason and the message and, under `wake`, wakes the launcher, which decides
whether to send it itself. The relay does not change the dispatch's latest report.

> Decision record: [ADR-0010](decisions/ADR-0010-remote-dispatch.md)

## Fleet goals

Fleet goals and their controller (`apps/server/src/fleet/goals/`, tools `goat_goal_*`) launch and
follow workers through the same launch services as the tools above, as the goal's owner thread and
never above its ceiling. They are off unless `fleet.controllerEnabled` is set. Host cordon,
placement limits and fallback chains do not exist yet; the controller reaches them through the
`goat/fleet/*` service tags, whose defaults are local-only. Design and current differences:
[agentic-k8s.md](../docs/internals/agentic-k8s.md).

> Decision record: [ADR-0016](decisions/ADR-0016-agentic-goals-controller.md)

> Decision record: [ADR-0017](decisions/ADR-0017-agentic-self-healing.md)

> Decision record: [ADR-0018](decisions/ADR-0018-agentic-resources-fallback.md)

## Permission profiles

goatclaw is open by default: `enabled` decodes to false and `defaultProfile` to the widest
built-in, `owner`. With `goatclaw.enabled`, `apps/server/src/goatclaw/PermissionProfiles.ts` admits agent launches
under the profiles in `packages/contracts/src/permissionProfiles.ts`. Current named settings
intersect the inherited launch snapshot and the caller's runtime ceiling; changing the default
does not reassign a child. Unknown stored profile ids refuse actions. Disabled policy keeps the
existing paths.

`apps/server/src/persistence/Migrations/097_PermissionProfiles.ts` stores bindings and lane
reservations outside the orchestration event log. Admission commits before launch; pending and
uncertain reservations retain capacity across restart. Local run projections and durable remote
dispatches determine completion, so removing a launch watch grants no capacity. An SSH launch requires
a destination that accepts the inherited ceiling. goatclaw is on or off fleet-wide:
`apps/server/src/goatclaw/FleetSync.ts` exchanges the policy with every connected host through
`goat_goatclaw_sync` and keeps the newest change. Launches and follow-up sends go through one rule,
`syncBeforeForwarding`: sync the destination first and never refuse because that sync is pending or
outdated, so hub steering cannot stall on it. A remote follow-up send forwards the caller's ceiling
and takes a lane that rides the target thread's dispatch. Bulk creation and remote cloud-holder forwarding refuse while enabled until
they preserve the same policy and accounting. Provider-native limits are outside this admission
service.

Role templates (`apps/server/src/goatclaw/RoleTemplates.ts`) are launch presets over these
profiles: `goatclawRole` on `goat_thread_launch` and `goat_ssh_thread_launch` puts the role's
preamble, lane defaults and shared report protocol in front of the message and has `claim` bind the child under
the role's stored profile intersected with the caller's, so a role only narrows. The role-to-profile
map lives in contracts beside the built-ins. Role launches refuse while goatclaw is off, which is how
turning it off stops new managers while running ones finish. GOAT Bot turns start outside any MCP
caller, so the dispatcher binds a full-access requester's turn to the supervisor profile with
`bind` before launch; requesters linked lower keep the default profile.

## Resource pressure

Each server classifies its own load, CPU, memory, disk and event-loop stalls into `ok`,
`elevated` or `critical` with hysteresis (`apps/server/src/fleet/pressure/HostPressureMonitor.ts`)
and reports it as `pressure` in its own `goat_host_status` entry, so remote pressure arrives with
the fan-out. `PressureNudger` tells the threads that started work on a pressured host, and their
launchers, through the launch-report channel: critical wakes, other changes are notices, each host
and level at most once per cooldown. It reads remote hosts only while a launch watch there still
has runs to report. Launch tools return `pressure` advice from readings already held, and goal
placement refuses a critical host. Settings: `fleet.pressure` in
`packages/contracts/src/hostPressure.ts`.

> Decision record: [ADR-0020](decisions/ADR-0020-host-pressure.md)

## Durable decisions

`apps/server/src/goatclaw/DecisionInbox.ts` and `packages/contracts/src/decisions.ts` keep durable
requests alongside projections of pending provider questions. Projections retain the existing response
path and its dispatch-time mode guard; approvals and questions above an agent's ceiling remain human-only.
A client's owner override requires authenticated settings-write and orchestration-operate scopes.

`apps/server/src/persistence/Migrations/098_DecisionInbox.ts` keeps decision state and append-only audit
metadata outside the orchestration log. Answer delivery commits to an outbox before sending a stable
thread message; the shared Scheduler retries each delivery independently. Projected answers keep an
audit intent before dispatch and reconcile it from the committed command receipt, so restart cannot
silently lose the answer's audit trail. Expiry closes requests without choosing a recommendation.
