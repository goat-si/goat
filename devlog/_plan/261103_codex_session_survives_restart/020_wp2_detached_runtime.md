# 020 — wp2: detached launcher, ownership record, verified termination, attach-or-spawn, setting

Criteria fed: c-4, c-6, part of c-5.

## 1. Setting (packages/contracts/src/settings.ts, settingsAccess.ts)
- New literal schema CodexTurnsSurviveServerStop = Schema.Literals(["off","restart","always"]).
- ServerSettings (near continueThreadsAfterServerUpdate :1439):
  codexTurnsSurviveServerStop: CodexTurnsSurviveServerStop.pipe(Schema.withDecodingDefault(Effect.succeed("restart"))).
- Patch schema (:1914) optionalKey; key list (:1124) + legacy optional struct (:1175) the same way continueThreadsAfterServerUpdate is.
- settingsAccess.ts: codexTurnsSurviveServerStop: agent (same class as continueThreadsAfterServerUpdate; reversible operational
  preference). If review argues "always" spends money after quit, switch to person(...) with that reason.
- Settings UI: add the control next to the restart-continuation preference (find with rg continueThreadsAfterServerUpdate apps/web).
  Labels: Off / Restarts and updates (default) / Also after quitting the app.

## 2. apps/server/src/provider/CodexDetachedAppServer.ts (NEW, ~350 lines; Context.Service)
```ts
export interface CodexDetachedRecord {
  readonly version: 1;
  readonly instanceId: ProviderInstanceId;
  readonly pid: number;          // spawned child pid
  readonly pgid: number;         // == pid (detached: true makes it a group leader)
  readonly socketPath: string;   // /tmp/goat-<uid>/codex/<24 hex>.sock (alias Codex creates)
  readonly fingerprint: string;  // sha256 of JSON [command, args, CODEX_HOME, cwd, env keys+values that shape Codex]
  readonly createdAt: string;
  readonly retainedAt?: string;  // set when a shutdown left it running
}
export class CodexDetachedAppServers extends Context.Service<CodexDetachedAppServers, {
  readonly open: (input: { instanceId; command; args; cwd; env; fingerprint }) =>
    Effect.Effect<{ channel: CodexAppServerMessageChannel; reattached: boolean; record: CodexDetachedRecord },
                  CodexDetachedAppServerError, Scope.Scope>;
  readonly retainOnClose: (instanceId: ProviderInstanceId) => Effect.Effect<void>; // set by 030 before shutdown
  readonly sweep: (keep: ReadonlySet<ProviderInstanceId>) => Effect.Effect<number>;  // startup
  readonly releaseIfUnclaimed: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}>()("goat/provider/CodexDetachedAppServers") {}
```
Record store: <stateDir>/codex-app-servers/<encodeURIComponent(instanceId)>.json, dir 0700, file 0600, atomic tmp+rename.
stderr: <stateDir>/codex-app-servers/<instance>.stderr.log opened O_TRUNC by GOAT, passed as the child's fd 2, GOAT closes its copy
after spawn (GOAT holds no fd). Termination error reads its last 8 KiB via the existing stderrExcerpt.

open():
1. Read record. If present: identity(record) ok AND fingerprint equal AND connect ok -> {reattached:true}; clear retainedAt.
   identity fails -> delete record (process gone or reused pid). fingerprint differs or connect fails while identity ok ->
   terminate(record) then spawn.
2. spawn: socket dir /tmp/goat-<uid>/codex (mkdir 0700; lstat: must be a dir owned by uid, mode & 0o077 == 0, else fail closed with
   CodexDetachedAppServerError). socketPath = dir/<randomHex(12)>.sock. Command = AgentScope.wrap(... shared:true) result +
   ["--listen", "unix://"+socketPath]; NodeChildProcess.spawn(cmd, args, {detached:true, stdio:["ignore","ignore",stderrFd], cwd, env});
   child.unref(); write record BEFORE readiness wait (crash-safe ownership).
3. readiness: connect with bounded retry (Schedule.spaced 50 ms, up to 30 s, via Clock so tests drive it with TestClock); child 'exit'
   before ready -> fail with stderr excerpt and delete record.
4. Scope finalizer: if retained(instanceId) -> close socket only, write retainedAt. Else terminate(record) and delete record.
   Closing for any non-shutdown reason (instance settings change, idle release, user stop) terminates as today.

identity(record): unix: `ps -o pgid=,command= -g <pgid>` via HostProcess (Linux may read /proc/<pid>/stat + cmdline); valid iff the
group exists, pgid === record.pgid, and some member's argv contains record.socketPath. Injected as a ProcessTable service so tests
use a fake table. Never match by name or pattern; never kill a pid outside a verified recorded group.
terminate(record): identity ok -> kill(-pgid, SIGTERM); await group exit via ProcessTable.awaitGone (bounded 5 s, TestClock) ->
kill(-pgid, SIGKILL); unlink alias socket if still present; delete record. identity fails -> delete record only.
sweep(keep): for each record whose instance is not in keep -> terminate. releaseIfUnclaimed(i): record with retainedAt still set ->
terminate.

## 3. CodexAdapterV2 wiring (MODIFY layerAppServerClientFactory, CodexAdapterV2.ts:1586-1648)
- Read settings.codexTurnsSurviveServerStop (ServerSettingsService) and process.platform. If "off" or win32 -> current stdio path
  unchanged. Else CodexDetachedAppServers.open(...) and build the client with CodexClient.layerMessageChannel(channel, clientOptions).
- The factory result gains `reattached: boolean` (CodexAppServerClientFactoryShape.open return type ->
  { client, reattached }; update the two call sites: openSession :1856 and the testkit factories).
- Same fingerprint inputs as the stdio launch (command/args after resolveSpawnCommand, cwd, env) so a settings change spawns fresh.
- Layer: CodexDetachedAppServers provided in the server layer graph next to the Codex driver (find where layerAppServerClientFactory
  is provided: rg layerAppServerClientFactory apps/server/src).

## Tests (failing first; fake ProcessTable + in-memory record dir + fake channel connector)
CodexDetachedAppServer.test.ts:
- "termination signals only a recorded group whose argv names the record's socket" (pid reused by another command -> record deleted,
  no signal sent).
- "a recorded process that is still listening is reattached instead of spawned".
- "a changed launch fingerprint terminates the old group and spawns".
- "sweep terminates records of instances outside the keep set and keeps the rest".
- "closing a retained instance leaves the process running and marks the record retained".
- "an unsafe socket directory fails closed" (group-writable or foreign owner).
Measurement for c-6 recorded in 001 E; re-measure with GOAT dev server in wp4.
Commands: vp test run apps/server/src/provider/CodexDetachedAppServer.test.ts + Codex adapter factory tests; vp run typecheck.

