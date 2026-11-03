# 013 — PR-A canonical implementation plan (wp1 + wp2). Self-contained; supersedes 010/020 where they differ.

Outcome: GOAT can run the shared Codex app-server outside its own process over a Unix-socket WebSocket, owns it through a durable record,
and cleans up any leftover after a crash before work starts. Behavior is unchanged for users: stdio stays the default; with the
internal switch on, the process is still terminated at shutdown and every leftover is terminated at startup. No reattach, no user
setting (both come in PR-B). Platform: macOS/Linux; Windows always stdio.

## Switch
apps/server config: env GOAT_CODEX_APP_SERVER_TRANSPORT = "stdio" (default) | "socket". Read once in the server config layer
(ServerConfig or the Codex driver's layer), documented in docs/operations/development.md only (maintainer knob). No settings key.

## 1. Transport (packages/effect-codex-app-server)
- NEW src/_internal/messageChannel.ts: CodexAppServerMessageChannel {incoming: Stream<string, CodexAppServerError>; send(msg):
  Effect<void, CodexAppServerError>; closed: Effect<CodexAppServerError>} and makeMessageChannelStdio(channel): Stdio (incoming ->
  bytes + "\n"; reject a message containing a raw "\n"; outgoing sink splits on "\n" and sends each complete line).
- MODIFY src/client.ts: export layerMessageChannel(channel, options) = Layer.effect(CodexAppServerClient, make(makeMessageChannelStdio
  (channel), options, channel.closed)); re-export the channel type.
- Tests (client.test.ts): round trip over an in-memory channel; peer EOF fails pending requests with the channel's closed error;
  peer error takes the error termination path (protocol.ts:447 branches); message with raw newline rejected.

## 2. UDS WebSocket connector (apps/server/src/provider/CodexAppServerSocket.ts, NEW)
- connectCodexAppServerSocket(socketPath): Effect<CodexAppServerMessageChannel, CodexAppServerSocketError, Scope> using ws
  (catalog 8.22.0; add "ws": "catalog:" to apps/server/package.json and @types/ws if present in the catalog) with
  `ws+unix://${socketPath}:/`, perMessageDeflate false, maxPayload 64 MiB + headroom; no Origin.
- send serialized by Semaphore(1); messages > 8 MiB sent as fragments ws.send(chunk, {fin}) split on bytes; > 64 MiB fails before writing.
- closed resolves on 'close' (code/reason) or 'error'; release closes 1000 then terminate().
- Tests (it.live, temp UDS + raw frame reader): 20 MB message arrives as > 1 FIN=0 fragments and reassembles; concurrent 20 MB + small
  messages keep order and do not interleave; multi-byte UTF-8 across fragment boundaries; peer close vs peer error; > 64 MiB refused.

## 3. Detached launcher + ownership (apps/server/src/provider/CodexDetachedAppServer.ts, NEW; Context.Service, Effect.fn names)
Record <stateDir>/codex-app-servers/<encodeURIComponent(instanceId)>-<12hex>.json (dir 0700, file 0600, tmp+rename):
{version:1, instanceId, state: "spawning"|"running"|"terminating", socketPath, pid?, pgid?, unit?, createdAt}.
Socket alias dir: /tmp/goat-<uid>/codex (mkdir 0700; lstat dir owned by uid, mode & 0o077 == 0, else fail -> stdio fallback with logged
reason). socketPath = dir/<24 hex>.sock; refuse (stdio fallback) if > 103 bytes; Codex's own physical path is
/tmp/codex-daemon-<uid>/<64 hex> (~95 bytes, 001 A).
spawn protocol (crash-safe ownership):
1. write record state "spawning" with socketPath (no pid);
2. command = AgentScope.wrap({command, args: [...appServerArgs, "--listen", "unix://"+socketPath], name:"codex", threadId, env,
   shared:true}) (survivesRestart left unset in PR-A); NodeChildProcess.spawn(cmd, args, {detached:true,
   stdio:["ignore","ignore", stderrFd], cwd, env}); child.unref();
3. synchronously rewrite record state "running" with pid, pgid=pid, unit (systemd unit name when wrapped);
4. readiness: connect retry with Schedule (50 ms spaced, 30 s cap) on Clock; child exit first -> fail with stderr excerpt (existing
   stderrExcerpt), terminate + delete record.
stderr: <stateDir>/codex-app-servers/<name>.stderr.log opened O_TRUNC, fd passed as child fd 2 and closed in GOAT after spawn.
Termination error for the client = channel closed error enriched with the stderr excerpt.
identity(record) via injected ProcessTable service (live impl: macOS `ps -o pid=,pgid=,command= -g <pgid>`; Linux /proc/<pid>/stat
field 5, /proc/<pid>/cmdline, /proc/<pid>/cgroup): verified | gone | mismatch | unverifiable (any read failure).
Verified = pgid matches AND a member's argv contains socketPath AND (wrapped) /proc/<pid>/cgroup names the unit.
terminate(record): verified -> write state "terminating"; wrapped -> systemctl --user kill --signal=SIGTERM <unit>, else kill(-pgid,
SIGTERM); await gone (bounded 5 s on Clock) -> SIGKILL same way; gone -> unlink alias if present, delete record.
gone|mismatch -> delete record, no signal. unverifiable -> keep record, no signal.
Session scope finalizer: terminate(record) (PR-A never retains). On server shutdown use the non-waiting variant: SIGTERM only, record
stays "terminating" (startup finishes it) — fits the launcher budget.

## 4. Startup barrier (serverRuntimeStartup.ts runOrderedV2StartupPhases :497-525, new phase "codex.detached-cleanup" after recover,
before recoverDelegatedTasks/startEffectWorker)
For each record: "running"/"terminating" -> terminate (waiting variant). "spawning" (no pid) -> if the socket accepts a connection,
initialize and turn/interrupt every active turn (thread/loaded/list all pages + thread/read status), then keep the record and report it
via the existing stray-process diagnostics; if not connectable, delete the record. unverifiable -> same socket interrupt, keep, report.
The phase completes before the effect worker starts, so no session opens before cleanup.

## 5. Factory wiring (CodexAdapterV2)
Budget: CodexAdapterV2.ts is 8608/8624 lines (oxlint-plugin-goat/code-budgets.json:288). Move makeCodexAppServerSpawnCommand,
makeCodexAppServerProtocolLogger, redaction helpers and layerAppServerClientFactory (:1481-1648) into NEW
Adapters/CodexAppServerClientFactory.ts and re-export from CodexAdapterV2.ts (consumers unchanged); lower the recorded budget to the
new length. In the factory: switch "socket" and platform !== "win32" -> CodexDetachedAppServers.open (always spawns in PR-A) +
CodexClient.layerMessageChannel; otherwise today's stdio path untouched.

## Tests (failing first, deterministic; fake ProcessTable + temp record dir; TestClock)
CodexDetachedAppServer.test.ts: signals only a verified group (pid reused by another command -> record deleted, no signal);
unverifiable -> no signal, record kept; spawning record written before spawn and completed after; startup terminates running and
terminating records and interrupts via socket for spawning/unverifiable ones; unsafe socket dir and over-long path fall back to stdio;
readiness fails with the stderr excerpt when the child exits first; Linux wrapped path verifies cgroup before systemctl kill.
CodexAppServerClientFactory test: switch off -> stdio command unchanged (existing adapter tests keep passing).

## Runtime check (wp2 C): dev server in this worktree with GOAT_CODEX_APP_SERVER_TRANSPORT=socket, Codex instance with a temp CODEX_HOME
pointing to the 001 mock provider; one turn completes; fd/process counts vs stdio; restart the dev server by tracked PID -> old process
terminated, record cleaned. NOT RUN: Linux runtime (macOS host).


## R9 fold (round 9, PR-A)
### Spawn-to-PID window and PID-less records (r9 P1 #1, #3)
- A Codex app-server can run turns only for a client connected to its socket; a process that has not bound its socket has no work.
- Ownership evidence without a recorded pid = the OS owner of the record's unique socket path: resolve the alias symlink to Codex's
  physical path, then macOS `lsof -t -U -a -- <physical path>` (or `lsof -Fp <physical path>`), Linux `ss -H -xlp src <physical path>`.
  The returned pid must have argv containing the record's socketPath; then it is "verified by socket" and gets pgid from ps. This is
  the AGENTS.md "owner of your port" rule applied to a private, random socket path; never matching by name.
- Startup for a "spawning" record: socket exists -> identify by socket owner -> terminate; no socket -> wait for it, bounded
  (SPAWN_SETTLE 30 s on Clock): appears -> identify and terminate; never appears -> the process cannot hold work: keep the record
  as "unbound" (re-checked at every startup), release the barrier, report it via stray-process diagnostics.
- Tests: crash before spawn (record without socket and no process -> deleted after settle with no socket and identity gone),
  immediately after spawn (socket appears during settle -> terminated), before readiness, after pid persistence.

### Fail-closed barrier (r9 P1 #2)
Outcome per record after the startup phase: cleaned | unbound (no socket, harmless) | blocked. blocked = a process that may hold work
(socket exists or verified alive) but could not be terminated or could not be confirmed stopped within the bound (terminate wait 5 s +
SIGKILL wait 5 s; socket-interrupt confirm 10 s). For a blocked instance, CodexDetachedAppServers.open fails with a visible
ProviderAdapterOpenSessionError: "A Codex process from before the restart (pid <pid>) is still running and could not be stopped.
GOAT will not start Codex for this provider until it stops." It re-checks on each open (cheap identity + socket probe), so the block
lifts as soon as the old process is gone. Restart continuations for that instance fail visibly through the same error (no turn/start).
Tests: disconnect during enumeration, incomplete enumeration, interrupt timeout, alive-but-unreachable process -> blocked, open
refused, later gone -> open succeeds.

### Shutdown order (r9 P2)
Shutdown finalizer signals first (SIGTERM to the verified group or unit), then writes "terminating". If the launcher kills GOAT before
the write, the record still says "running" and startup terminates it; correctness never depends on the shutdown write. Test: forced
termination after the signal and before the write -> startup cleans the process.

### Switch flip (implementation check from r9)
Startup cleanup always scans records regardless of GOAT_CODEX_APP_SERVER_TRANSPORT, so records from a previous socket-mode run are
cleaned after switching back to stdio. Test.


## R10 fold (round 10, PR-A) — supersedes the "Spawn-to-PID window" part of R9
### Exclusive-create pid handshake (r10 P1 #2, P2)
The child records its own pid before Codex can exist, and startup can atomically forbid a late start:
- Launch = /bin/sh -c 'set -C; printf %s "$$" > "$1" || exit 75; shift; exec "$@"' goat-codex <pidFile> <AgentScope-wrapped command...>
  with detached:true. pidFile = <stateDir>/codex-app-servers/<name>.pid (dir 0700). The shell's pid becomes the AgentScope shell and
  then Codex through exec (AgentScope.ts:84 "Exec at every step preserves the agent PID"), and is the group leader (detached).
- noclobber (O_EXCL): the write fails if the file exists; the shell then exits 75 without exec.
- Startup for any record: pidFile exists -> pid known -> identity/terminate as for "running" (argv contains socketPath, or still the
  pre-exec shell whose argv contains the unique pidFile path). pidFile absent -> startup creates it with O_EXCL containing "abandoned":
  success proves no Codex can start for this record later (the pending shell, if any, fails its write and exits) -> delete record and
  pidFile after the spawning shell is gone or never existed; O_EXCL failure -> the shell won the race -> re-read pid and continue as
  "pid known". No settle window, no late bind.
- Lifecycle: record states spawning (record + no pidFile) | running | terminating; deletion only after (a) pidFile "abandoned", or
  (b) identity gone/mismatch for the recorded pid, or (c) confirmed termination.
- Tests: crash before spawn (startup writes "abandoned", record deleted); shell started but blocked before its write (fake: startup
  wins O_EXCL, shell exits 75, no Codex); shell wrote pid, Codex not yet bound (terminated by pid); after readiness (normal).

### Block enforced before transport selection (r10 P1 #1)
The per-instance blocked check (R9 barrier) runs in the factory BEFORE choosing stdio or socket, so a blocked socket-mode leftover also
blocks a default stdio spawn. Test: blocked record -> restart with the switch at stdio -> open refused with the visible error; old
process gone -> open succeeds on stdio.


## R11 fold (round 11, PR-A) — amends R10 handshake
### Atomic publish (r11 P1 #2)
Shell: `printf %s "$$" > "$1.$$" && ln "$1.$$" "$1" || { rm -f "$1.$$"; exit 75; }; rm -f "$1.$$"; shift; exec "$@"`.
link(2) is atomic and fails if the name exists, so pidFile is either absent or complete. Startup claims with the same method
(write "abandoned" to a temp name, link to pidFile). Malformed content (neither digits nor "abandoned") -> instance blocked, nothing
deleted. Stray "<pidFile>.<n>" temp files are removed only together with their record.

### Tombstones are kept until a reboot proves no paused shell exists (r11 P1 #1)
An "abandoned" pidFile is never deleted while the boot that created its record is current. Records carry bootId (macOS
`sysctl -n kern.boottime`, Linux /proc/sys/kernel/random/boot_id). Startup deletes a tombstoned record and its pidFile only when the
current bootId differs (every process of the old boot is gone). A tombstone costs two small files and blocks nothing (the instance is
not blocked by a tombstone: the shell cannot exec Codex). Test: delayed shell released after startup's cleanup pass -> its link fails,
exit 75, no Codex; tombstone survives the pass; changed bootId -> deleted.

### Identity across every exec stage (r11 P1 #3)
The outer shell's argv already contains the full wrapped command including "--listen unix://<socketPath>", and every exec stage keeps
the same pid and pgid (AgentScope.ts:84). Identity = pid exists AND pgid === recorded pgid (== pid) AND argv contains socketPath —
true for the pre-exec shell, the AgentScope shell, systemd-run, and Codex. cgroup is not part of identity. Termination: kill(-pgid)
always; additionally, when a unit is recorded and /proc/<pid>/cgroup names it, systemctl --user kill <unit> (catches setsid MCP
descendants). Any unreadable field -> unverifiable -> blocked, nothing deleted. Tests: pause at pre-exec, AgentScope shell, systemd-run,
Codex: all verify and terminate; unreadable /proc -> blocked.

