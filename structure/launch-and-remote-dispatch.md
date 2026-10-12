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
`apps/server/src/mcp/completionWebhook.ts`, which posts it to the `completionWebhook` server
setting.

A launch from an MCP client outside any thread has no launcher to wake. `watchExternal` gives it a
launcherless watch only when the completion webhook takes it: the webhook is on and the launch
passed `notifyWebhook: true`, or `completionWebhook.externalLaunches` is set. Otherwise it records
nothing, as before. Such a watch has `launcherThreadId: null` and stores the client's runtime
mode ceiling in `ceiling`, so its remote reads never go above what that client was approved for.
Its reports go only to the webhook, with `launcherThreadId: null` in the payload. It is deleted once
its run is reported or the thread is gone, because no thread can re-arm or unwatch it. For the same
reason it is also dropped while its run is still owed once the webhook would no longer post its
reports, or seven days after it was created.
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
`apps/server/src/persistence/Migrations/064_RemoteDispatches.ts` creates that table. Reports use
`apps/server/src/persistence/Migrations/063_RemoteReports.ts` and `RemoteReportService`.
`apps/server/src/persistence/Migrations/066_RemoteDispatchQuestions.ts` adds
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

> Decision record: [ADR-0010](decisions/ADR-0010-remote-dispatch.md)
