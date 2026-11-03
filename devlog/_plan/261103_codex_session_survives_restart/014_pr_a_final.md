# 014 — PR-A FINAL implementation plan (wp1 + wp2). Canonical; supersedes 010, 020, 013 and their folds for PR-A.

## Outcome
GOAT can run each provider instance's shared Codex app-server outside its own process over a WebSocket on a Unix socket, owns that
process through a durable record, and before any work starts it cleans up whatever a crash left behind. Users see no change: stdio
stays the default (internal switch), and in socket mode the process is still terminated at shutdown and any leftover is terminated
at startup. No reattach, no user setting, no survival (PR-B). macOS/Linux only; Windows always stdio.

## 0. Switch
GOAT_CODEX_APP_SERVER_TRANSPORT = "stdio" (default) | "socket", read once in the Codex driver layer; documented in
docs/operations/development.md. The startup cleanup (§5) and the block check (§6) run in BOTH modes.

## 1. Transport (packages/effect-codex-app-server)
NEW src/_internal/messageChannel.ts: `CodexAppServerMessageChannel {incoming: Stream<string, CodexAppServerError>;
send(message): Effect<void, CodexAppServerError>; closed: Effect<CodexAppServerError>}` and makeMessageChannelStdio(channel): Stdio
(incoming -> utf8 bytes + "\n", a message containing a raw "\n" fails with CodexAppServerTransportError read-input-stream; outgoing
sink buffers and sends each complete line). MODIFY src/client.ts: layerMessageChannel(channel, options) = Layer.effect(
CodexAppServerClient, make(makeMessageChannelStdio(channel), options, channel.closed)); export the type.
Tests (client.test.ts): round trip; peer EOF -> pending requests fail with the closed error; stream error -> error path
(protocol.ts:447 branches); raw newline rejected.

## 2. UDS WebSocket connector — apps/server/src/provider/CodexAppServerSocket.ts (NEW)
connectCodexAppServerSocket(socketPath): Effect<CodexAppServerMessageChannel, CodexAppServerSocketError, Scope> with ws (catalog
8.22.0; add "ws": "catalog:" to apps/server/package.json; @types/ws only if in the catalog) at `ws+unix://${socketPath}:/`,
perMessageDeflate:false, maxPayload 80 MiB, no Origin. send: Semaphore(1); > 64 MiB fails before writing; > 8 MiB split on bytes into
fragments ws.send(chunk,{binary:false, fin:last}). closed resolves once on 'close' (code, reason) or 'error'. Release: close(1000),
terminate() if still open.
Tests (it.live with a temp UDS server and a raw frame reader): 20 MB -> >1 FIN=0 frames reassembled; concurrent 20 MB + small keep
order without interleaving; multi-byte UTF-8 across a fragment boundary; peer close vs peer error; > 64 MiB refused.

## 3. Records — apps/server/src/provider/CodexDetachedAppServer.ts (NEW Context.Service CodexDetachedAppServers; Effect.fn names)
Dir <stateDir>/codex-app-servers (0700). Per spawn name = <encodeURIComponent(instanceId)>-<12 hex>:
- <name>.json (0600, tmp+rename): {version:1, instanceId, name, socketPath, pgid?, unit?, bootId, state:"spawning"|"running"|
  "terminating", createdAt}. bootId: macOS `sysctl -n kern.bootsessionuuid`, Linux /proc/sys/kernel/random/boot_id; unreadable ->
  record marked bootId:null (tombstones then never expire, §5).
- <name>.pid published atomically (§4); content = decimal pid or "abandoned".
- <name>.stderr.log (O_TRUNC; fd handed to the child as fd 2, GOAT closes its copy after spawn).
Socket alias: /tmp/goat-<uid>/codex/<24 hex>.sock; dir mkdir 0700 then lstat: directory, owned by uid, mode & 0o077 == 0; alias path
<= 103 bytes. Any failure -> stdio fallback for this open with a logged reason (still subject to §6).

## 4. Spawn with an atomic pid handshake
1. write record state "spawning".
2. inner = AgentScope.wrap({command, args:[...appServerArgs, "--listen", "unix://"+socketPath], name:"codex", threadId, env,
   shared:true}).
3. spawn("/bin/sh", ["-c", 'printf %s "$$" > "$1.$$" && ln "$1.$$" "$1" || { rm -f "$1.$$"; exit 75; }; rm -f "$1.$$"; shift;
   exec "$@"', "goat-codex", pidFile, inner.command, ...inner.args], {detached:true, stdio:["ignore","ignore",stderrFd], cwd, env});
   unref. The shell's pid is the group leader (detached) and every exec stage keeps pid and argv containing socketPath
   (AgentScope.ts:84). Exit 75 = startup claimed the pid file first (§5): no Codex starts.
4. write record state "running" with pgid = child.pid and unit (when wrapped).
5. readiness: connect with Schedule spaced 50 ms, cap 30 s, on Clock; child exit first -> fail with the stderr excerpt
   (stderrExcerpt), terminate (§5) and remove the record.

## 5. Identity, termination, startup cleanup
groupMembers(pgid) (injected ProcessTable; live: `ps -A -o pid=,pgid=,command=` filtered by the numeric pgid; Linux may read /proc):
a NUMERIC match on the recorded group id, never a name match.
ownerOfSocket(socketPath): resolve the alias symlink to Codex's physical path; macOS `lsof -t -- <physical>`, Linux
`ss -H -xlp src <physical>`; the result pid must have argv containing socketPath.
classify(record):
- verified: some member of groupMembers(pgid) has argv containing socketPath (leader may be dead: a Node launcher's native child
  stays in the group), OR ownerOfSocket returns a pid whose argv contains socketPath (then pgid := that pid's pgid).
- gone: groupMembers(pgid) is empty AND the socket does not accept a connection (or does not exist).
- mismatch: members exist but none carries socketPath, and the socket is dead -> pid/pgid reuse.
- unverifiable: any ProcessTable/lsof/ss/proc read failed, or members carry socketPath inconsistently with the socket owner.
terminate(record) when verified: SIGTERM to -pgid, and when a unit is recorded and /proc/<member>/cgroup names it, also
`systemctl --user kill --signal=SIGTERM <unit>`; await classify == gone (bounded 5 s on Clock); else SIGKILL the same way and await
5 s; confirmed gone -> unlink alias if left, delete record + pid file; not confirmed -> outcome blocked.
Startup phase "codex.detached-cleanup" inside runOrderedV2StartupPhases (serverRuntimeStartup.ts:497-525) after recover and before
recoverDelegatedTasks/startEffectWorker; for every record of this state dir:
- pid file absent: claim it by writing "abandoned" to <pid>.tmp and link(2) to <name>.pid. Claim succeeds -> no Codex can ever start
  for this record; keep record+pid file as a tombstone until bootId differs from the current boot (then delete). Claim fails -> the
  shell won; read the pid and continue below.
- pid file malformed -> blocked (nothing deleted).
- pid known (or state running/terminating): classify -> verified: terminate; gone|mismatch: delete record + pid file; unverifiable:
  blocked.
- tombstone with a different bootId -> delete.
Outcomes are cleaned | tombstoned | blocked. blocked instances are remembered in memory and re-classified on each open (§6).
Session close (any reason, PR-A): terminate. Server shutdown: SIGTERM first (no wait), then write "terminating"; if the launcher
kills GOAT before the write the record still says running and the next startup terminates it.

## 6. Factory (CodexAdapterV2) — block check before transport choice
Budget: CodexAdapterV2.ts 8608/8624 (oxlint-plugin-goat/code-budgets.json:288). Move makeCodexAppServerSpawnCommand,
makeCodexAppServerProtocolLogger, the protocol redaction helpers and layerAppServerClientFactory (CodexAdapterV2.ts:1481-1648) to NEW
Adapters/CodexAppServerClientFactory.ts, re-export from CodexAdapterV2.ts, and lower the recorded budget to the new length.
open(): first CodexDetachedAppServers.ensureNotBlocked(instanceId) — re-classifies blocked records; still blocked -> fail
ProviderAdapterOpenSessionError "A Codex process from before the restart (group <pgid>) is still running and could not be stopped.
GOAT will not start Codex for this provider until it stops." Then: switch "socket" && platform !== "win32" -> spawn (§4) +
layerMessageChannel; else today's stdio path unchanged.

## 7. Tests (failing first; fake ProcessTable/socket probe/record dir; TestClock; no sleeps)
CodexDetachedAppServer.test.ts:
1. signals only a verified group; pid reused by an unrelated command (mismatch) -> record deleted, no signal.
2. leader dead, native child alive in the group carrying socketPath -> verified -> group terminated (reviewer r12 case).
3. unverifiable (ProcessTable read fails) -> blocked, nothing signalled or deleted; open refused with the visible error; later gone ->
   open succeeds.
4. crash before spawn (record spawning, no pid file, no process) -> claim succeeds -> tombstone kept this boot; next boot id ->
   deleted.
5. shell paused before its link, startup claims first -> shell's link fails (exit 75), no Codex; tombstone retained.
6. shell published pid, Codex not yet bound -> verified by argv -> terminated.
7. malformed pid file -> blocked.
8. termination not confirmed after SIGKILL -> blocked.
9. forced shutdown after SIGTERM before the "terminating" write -> startup terminates.
10. switch back to stdio with a blocked socket record -> stdio open refused until gone.
11. unsafe socket dir / alias > 103 bytes -> stdio fallback with logged reason.
12. readiness: child exits first -> error carries the stderr excerpt, record removed.
13. Linux wrapped: unit kill only when /proc/<member>/cgroup names the unit; unreadable /proc -> unverifiable.
Factory: switch default -> stdio command and args unchanged (existing CodexAdapterV2 tests stay green).
Runtime (C phase): dev server in this worktree with the switch on and a temp CODEX_HOME using the 001 mock provider: one turn
completes over the socket; fd/process counts vs stdio; dev server restart by tracked PID -> old group terminated, record removed.
NOT RUN expected: Linux runtime (macOS host).


## R13 fold (NEAR-PASS residual plan refinements)
- classify, members without socketPath and socket dead: leader (pid == recorded pgid) alive without socketPath -> mismatch (the
  group id was reused; a pid cannot be reused while its group still has members, so a live leader proves reuse) -> leave it alone,
  delete record. Leader absent but members remain -> our Codex's leftover tool processes -> verified-orphans -> terminate the group.
- Any combination not listed (e.g. group empty, socket accepting, owner lookup returns no pid) -> unverifiable -> blocked.
- Implementation checks carried to wp2 C: ps -ww full command lines; lsof -t on the physical UDS path (fallback stays fail-closed);
  Linux systemd-run exec-in-place and ss owner lookup; native Codex never setsid/setpgid before bind; link(2) on the state FS;
  finalizer receives the close reason (server_shutdown -> signal and continue; others -> bounded wait); adapter under budget, new
  files < 800 lines.


## R14 (implementer finding, supersedes the R13 "verified-orphans" bullet)
POSIX only forbids reusing a group id while that group has members; after our group fully disappears the same pid can lead a new,
unrelated group whose leader then dies, leaving children that match the stale record. Without a creation-time identity that
distinguishes the two (macOS exposes no reliable per-process environment or start-time marker to an unprivileged reader here), a
signal is authorized ONLY by a member whose argv contains socketPath or by socket ownership. Leaderless members without that evidence
-> treated as gone for this record: delete the record, no signal, log them as possible leftovers. This equals today's stdio exposure to
orphaned tool processes when Codex dies.
