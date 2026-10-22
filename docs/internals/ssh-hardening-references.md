# SSH hardening references

This page compares GOAT's SSH connection layer with four tools that solve the
same problem, then lists what to change next. It is a working backlog: when an
item ships, remove it here and update [SSH reconnect](ssh-reconnect.md) if the
behavior it describes changed.

The references were read from pinned checkouts. Nothing in them was built, run,
or connected; values are configured timers, not measured recovery times.
Citations are `repo:path:line` at these commits:

| Short name   | Source                                                                       | Commit     | What it is                                                    |
| ------------ | ---------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| cmux         | [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux)                      | `42048bdd` | macOS terminal; `cmux ssh` with a remote daemon, relay, Mosh  |
| herdr        | [herdrdev/herdr](https://github.com/herdrdev/herdr)                          | `143bf5fd` | Rust agent multiplexer with saved SSH machines                |
| herdr-web-ui | [devswha/herdr-web-ui](https://github.com/devswha/herdr-web-ui)              | `a8f2b038` | Browser and phone client that reaches PCs over SSH            |
| Codex        | [openai/codex](https://github.com/openai/codex) and the Codex desktop bundle | `816fa702` | `codex-rs` source; desktop paths are a beautified local build |

Longer per-reference notes, with every topic and its "not present" results,
live outside this repository in the maintainer's analysis corpus
(`213_cmux-herdr-ssh-analysis/`).

## Where GOAT stands

GOAT is already at or ahead of the references on most axes. Its retry ladder
is jittered (1 s base, 5 min cap, upper-half jitter) and resets only after
30 s of stable connection
(`packages/client-runtime/src/connection/supervisor.ts:40`,
`supervisor.ts:128`). Remote commands run through `runSshCommand` and SSH
forwards carry
`ServerAliveInterval=15`/`ServerAliveCountMax=3`
(`packages/ssh/src/command.ts:122`), and the RPC session has a 15 s silence
budget, so a dead link is noticed in about 15–20 s
(`packages/client-runtime/src/rpc/protocol.ts:21`). Failures are classified
into quiet, retrying, and blocked states (#361, #379); on macOS and Linux,
forwards die with their owner process (#378; Windows still lacks that fence,
`packages/ssh/src/tunnelOwner.ts:57`); duplicate wakes collapse and network
path changes after a drop are seen (#381); one reconnect runs one SSH
preparation (#382). Runtime archives are SHA-256 checked locally
(`packages/ssh/src/runtimeArchiveHttp.ts:113`) and again on the host
(`packages/ssh/src/tunnel.ts:884`). Turns and committed state live on the
remote server, so a dropped transport stops neither; subscriptions replay
from their cursor, and an in-flight mutation fails rather than replaying.

What remains is the latency of the remote commands themselves; see the
backlog below.

## What the references do

**cmux** has three generations of remote code; the Rust `cmux-tui` carrier is
now the default for interactive `cmux ssh` (`cmux:CLI/cmux.swift:14085`).

- Carrier recovery retries immediately, then full jitter under ceilings of
  100 ms doubling to 5 s, with a 15 s per-attempt deadline and no attempt or
  duration limit (`cmux:cmux-tui/crates/cmux-remote/src/connection.rs:63`,
  `connection.rs:803`). An application heartbeat (5 s interval, 15 s timeout)
  covers a blocked write as well as a missing reply (`connection.rs:943`).
- The older daemon coordinator parks a session after three identical bootstrap
  failures, eight total, or an authentication block, and parks if no proxy is
  ready 60 s after the first daemon hello
  (`cmux:Packages/macOS/CmuxRemoteSession/Sources/CmuxRemoteSession/Reachability/RemoteBootstrapRetryPolicy.swift:27`,
  `.../Session/RemoteSessionCoordinator+Readiness.swift:16`). On sleep it cancels
  scheduled retries and the readiness deadline and ignores late reachability
  callbacks; wake clears suspension and retries unhealthy transports on a 2 s
  base (`.../Session/RemoteSessionCoordinator+SystemPower.swift:24`,
  `SystemPower.swift:28`).
- Connection sharing is on by default for cmux-managed sockets:
  `ControlMaster=auto`, `ControlPersist=600`, a private `ControlPath`, and a
  route-specific socket when proxy or identity settings differ. A ControlPath
  the user configured is left alone
  (`cmux:Packages/macOS/CmuxFoundation/Sources/CmuxFoundation/SSHConnectionSharingOptions.swift:236`,
  `SSHConnectionSharingOptions.swift:274`). The reverse relay is added to the
  master with `ssh -O forward` and removed with the exact spec on teardown
  (`.../Session/RemoteSessionCoordinator+ReverseRelayControlMaster.swift:45`,
  `ReverseRelayControlMaster.swift:101`).
- A new stdio bridge claims its slot with a fresh lease ID and closes every
  older bridge, including half-open ones, without waiting for TCP to notice
  (`cmux:daemon/remote/cmd/cmuxd-remote/persistent_bridge_lease.go:54`).
- Transient retries publish "reconnecting" with no detail, so the sidebar does
  not flash red; the error appears when the session parks, and a context menu
  offers **Copy SSH Error**
  (`.../Session/RemoteSessionCoordinator.swift:389`,
  `cmux:Sources/TabItemView+WorkspaceContextMenu.swift:204`).
- Mosh carries only the interactive terminal; bootstrap, RPC, relay, and
  uploads stay on SSH, and blocked-UDP recovery is deferred
  (`cmux:docs/remote-daemon-spec.md:37`, `remote-daemon-spec.md:39`).
- Tests block the heartbeat write, wedge a daemon behind live pipes, and cut
  or delay a carrier through a TCP proxy
  (`cmux:cmux-tui/crates/cmux-remote/src/connection.rs:2034`,
  `cmux:Packages/macOS/CmuxRemoteDaemon/Tests/CmuxRemoteDaemonTests/RemoteDaemonRPCClientKeepaliveTests.swift:109`,
  `cmux:cmux-tui/crates/cmux-remote/tests/pty_reconnect_e2e.rs:72`).

**herdr** keeps one supervisor per saved machine.

- Deterministic ladder 0.5 s doubling to 120 s, no jitter; the ladder resets
  only after the connection has been _ready_ (initial snapshot received) for
  60 s, so a handshake during a maintenance wake does not count
  (`herdr:src/client/endpoint/supervisor.rs:11`, `supervisor.rs:291`,
  `supervisor.rs:563`).
- Sleep cancels in-flight attempts (`supervisor.rs:325`). For 30 s after an
  interactive wake every failed attempt waits at most 2 s, so Wi-Fi can
  reassociate quickly; failures still count, so the ladder resumes from its
  advanced position after the window (`supervisor.rs:16`, `supervisor.rs:297`).
  Live connections are probed on wake, not replaced.
- Failures that need a person (`Attention`: auth, host key, version) are
  re-checked quietly every 30 s, so an `ssh-add` or a fix on the host
  recovers without a click (`supervisor.rs:280`,
  `herdr:docs/preview/website/src/content/docs/connecting-machines.mdx:14`).
- On POSIX with the managed SSH config (the default), the generated config
  includes the user's config before its keepalive fallbacks, and commands ride
  a scoped master (`-S <private path>`, `ControlMaster=auto`,
  `ControlPersist=600`). Background commands also pass
  `ServerAliveInterval=15`/`ServerAliveCountMax=4`,
  `NumberOfPasswordPrompts=0`, and `ConnectionAttempts=1` on the command line
  (`herdr:src/remote/attach.rs:1402`, `attach.rs:1433`, `attach.rs:3171`). The
  transport is a remote command over SSH stdio, so there is no port forward to
  manage.
- When both ends support it, the remote bridge exits after 60 s with no
  traffic in either direction, measured on a clock that counts sleep, so a
  client that vanished does not leave a bridge behind
  (`herdr:src/platform/remote_bridge.rs:8`, `connecting-machines.mdx:94`).
- Background reconnects only discover installed packages; installing or
  updating the remote needs an explicit, interactive setup
  (`connecting-machines.mdx:28`).

**herdr-web-ui** reaches each PC from a local Bun server.

- On Linux and macOS, one private master per PC (`ssh -M -N -T -S <tmp>/control`),
  with forwards added through it by `-O forward`; Windows uses standalone
  connections (`herdr-web-ui:server/ssh.ts:203`, `server/ssh.ts:324`). Host
  disconnect bumps a generation, clears timers, closes relays, and kills the
  master and its children (`server/machines.ts:817`, `server/ssh.ts:379`).
- The browser socket probes after 20 s of silence with a correlated
  ping/pong; ordinary frames cannot satisfy a probe, and two misses replace the
  socket. A deadline that fires more than 2 s late is treated as a frozen page
  and restarted instead of counted as a miss
  (`herdr-web-ui:src/lib/ws.ts:35`, `src/lib/ws.ts:446`, `src/lib/ws.ts:484`).
- Setup shows the last 8 sanitized lines of SSH output while a prompt waits
  (`herdr-web-ui:server/ssh.ts:46`).
- Tests use fake timers for flapping and frozen deadlines, and a fake SSH that
  kills a forward after its second TCP connection
  (`herdr-web-ui:src/lib/ws.test.ts:875`, `src/lib/ws.test.ts:1312`,
  `server/ssh.test.ts:183`).

**Codex** desktop runs WebSocket over the stdio of `ssh ... codex app-server
proxy`, so it needs no local `-L` port for the main transport. Desktop paths
are relative to the bundle's `snapshots/vite-build-beautified/`.

- Ladder 1 s doubling to 20 s, with per-host deterministic jitter of up to
  500 ms (`bootstrap-yYZ8rgHq.js:62449`, `bootstrap-yYZ8rgHq.js:65988`). SSH
  uses `ServerAliveInterval=15`/`ServerAliveCountMax=12`
  (`main-C3nRcJ3D.js:1076`) plus a WebSocket ping every 10 s with a 60 s pong
  budget (`application-network-startup-DN7Ktmlk.js:9334`).
- When this machine's network was offline for at least 5 s and comes back, a
  connected SSH session is replaced even if its socket still claims to be open
  (`bootstrap-yYZ8rgHq.js:66036`).
- After reconnect, conversations are resumed at most two at a time
  (`bootstrap-yYZ8rgHq.js:49659`).
- Forward cleanup kills the child and also sends `ssh -O cancel -L ...`, in
  case the user's own config multiplexed it (`bootstrap-yYZ8rgHq.js:63173`).

## Gap table

| Concern                      | GOAT today                                                                                                                                                                                                                                                                                                                | Best reference practice                                         | Gap           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------- |
| Backoff and jitter           | 1 s→5 min, upper-half jitter, 30 s stable reset                                                                                                                                                                                                                                                                           | cmux full jitter; herdr resets on 60 s _ready_                  | none          |
| Post-wake retries            | flat 2 s for 30 s after long resume, failure count held at zero                                                                                                                                                                                                                                                           | herdr caps at 2 s for 30 s after wake                           | none          |
| Suspend                      | cancels establishment and retry timers until wake                                                                                                                                                                                                                                                                         | herdr cancels in-flight attempts; cmux cancels timers           | none          |
| Blocked recovery             | local proxy re-checks every 60 s while staying blocked; other blocks wait for a signal                                                                                                                                                                                                                                    | herdr re-checks every 30 s                                      | none          |
| SSH handshakes per reconnect | one owned POSIX master per target; commands and the forward reuse it; the user's own sharing is left alone; the cost log separates masters and control commands                                                                                                                                                           | one scoped master per host in cmux, herdr, herdr-web-ui (POSIX) | none          |
| Setup deadline               | an unchanged reconnect runs one remote command and starts `goat` once (readiness); the saved token is reused; ordinary setup learns each host (15–45 s); answered runtime preparation has a non-renewing native 15-minute total lifetime, then ordinary opening and 75 s snapshot budgets; preparation expiry counts once | none of the references probe a runtime on each reconnect        | none          |
| Stalled link                 | ServerAlive + RPC silence budget; real loopback stall tests cover RPC timeout and forward revalidation                                                                                                                                                                                                                    | cmux blocked-write and carrier-cut fixtures                     | none          |
| Abandoned server sockets     | 120 s inbound idle timeout tolerates throttled hidden tabs; clients ping every 5 s (`apps/server/src/wsIdleTimeout.ts`)                                                                                                                                                                                                   | herdr bridge idles out at 60 s; cmux lease evicts older bridges | none          |
| Git over SSH                 | `GIT_SSH_COMMAND` carries ServerAliveInterval=15 / ServerAliveCountMax=3; a real-socket test stalls a fetch and sees keepalive end it (#408)                                                                                                                                                                              | every other SSH path carries ServerAlive                        | none          |
| Error detail                 | tooltip; connection menu and thread banner copy a sanitized public diagnostic                                                                                                                                                                                                                                             | cmux Copy SSH Error; herdr-web-ui last 8 lines                  | none          |
| Frozen timers (web, mobile)  | long resume replaces the session; timers over 2 s late restart the RPC silence budget                                                                                                                                                                                                                                     | herdr-web-ui treats a late deadline as a freeze                 | none          |
| Archive pinning              | SHA-256 locally and on the host                                                                                                                                                                                                                                                                                           | same                                                            | none          |
| Session resume               | server owns turns and state; subscriptions replay from cursor; mutations never replayed                                                                                                                                                                                                                                   | cmux keeps replay state 120 s; herdr keeps panes running        | none          |
| Forward lifetime             | owner-death fence on POSIX, 2 s bounded teardown (#378); Windows unfenced                                                                                                                                                                                                                                                 | herdr-web-ui and Codex kill by captured PID                     | none on POSIX |
| Roaming transport (Mosh)     | none                                                                                                                                                                                                                                                                                                                      | cmux uses it for the terminal only                              | non-goal      |

Two reference behaviors are deliberately not adopted. cmux's older coordinator
parks a session after a bounded number of failures; GOAT never gives up on a
host that may simply be asleep, and the long cap keeps that cheap. herdr
installs only during interactive setup; GOAT's owning client installs its
release on first connection by design
([SSH upgrades](../../structure/ssh.md#upgrades)). Mosh roams a terminal, but
GOAT's transport is HTTP and WebSocket to a server that already outlives the
link, so reconnect plus cursor replay covers the same need.

## Backlog

Each item names what to verify on the real app. The test hosts are
`mac-studio` (direct), `macmini-cf` (behind `cloudflared access ssh`), and the
saved `jun-macbookpro` connection, which is offline and therefore the
unreachable case. Drive a development desktop over its DevTools port
(`GOAT_DESKTOP_REMOTE_DEBUGGING_PORT`), read the Connections row, and take
host-side evidence over plain `ssh`: a process sampler on the host that counts
`goat` starts per SSH connection separates this client's work from other
clients'. A stalled link is simulated with a loopback relay in the path (for
example a `ProxyCommand` through a relay that can stop forwarding), never by
stopping ssh itself: a stopped ssh also stops its keepalive.

Reconnects measured with a development desktop attached to each host's
existing runtime, 5 per host, each triggered by killing the app's SSH master.
"SSH" is the `ssh.reconnect.cost` wall time; "Total" runs from the kill until
the Connections row reads Connected and also covers the client's work after
SSH. Commands exclude the master. `goat` starts are this client's on the host.
Round 3 published 6.8 s and 19.3 s; its rows here were re-measured with
round 4 on 2026-10-19 and 2026-10-20 against the same runtimes
(`mac-studio` 0.1.0-dev.…g52be2c095, `macmini-cf` 0.1.0-dev.b1dc5be3d).

| Host         | Build                 | Total  | SSH    | Commands | `goat` starts | Pairings | First attempt |
| ------------ | --------------------- | ------ | ------ | -------- | ------------- | -------- | ------------- |
| `mac-studio` | round 2 (`6be4bffc8`) | 25.3 s |        |          | 47            | 1        | 5/5           |
| `mac-studio` | round 3 (`ac40fe793`) | 7.3 s  | 3.9 s  | 3        | 2–9           | 1        | 5/5           |
| `mac-studio` | token reuse (#413)    | 6.0 s  | 2.9 s  | 2        | 1–28          | 0        | 6/6           |
| `mac-studio` | round 4 (#428)        | 5.8 s  | 3.0 s  | 1        | 1             | 0        | 5/5           |
| `macmini-cf` | round 2 (`6be4bffc8`) | 36.8 s |        |          | 47            | 1        | 0/5           |
| `macmini-cf` | round 3 (`ac40fe793`) | 22.6 s | 14.8 s | 3        | 2             | 1        | 5/5           |
| `macmini-cf` | token reuse (#413)    | 20.5 s | 12.1 s | 2        | 1             | 0        | 5/5           |
| `macmini-cf` | round 4 (#428)        | 14.0 s | 7.2 s  | 1        | 1             | 0        | 5/5           |

`mac-studio` runs other clients' agents, so its `goat` counts are noisy. A cached
deferred refresh now reconnects in one command. That command waits briefly for
a competing replacement and verifies attachment under the replacement mutex;
an unresolved lock returns pending without admitting a draining runtime.
Behind `cloudflared` every removed
command saves about 2 s. The first reconnect after an install starts `goat`
once instead of about 10 times (#415, #419), counted in the real-shell
fixture; no host was upgraded to measure it, because both run threads.

A Git clone from `mac-studio` stalled mid-transfer through the relay failed on
keepalive 56.5 s after the stall; without the keepalive arguments it was still
waiting at 197 s.

Round 5 was measured from `mac-studio` as the client, which cannot reach
`macmini-cf`, against fresh users on `clisu-oracle` (Ubuntu arm64, published
runtime `0.1.0-nightly.20261019.194`). The carriers are plain SSH over
Tailscale and a Cloudflare quick tunnel (`cloudflared tunnel --url ssh://…`
with `cloudflared access ssh` as the `ProxyCommand`). A headless driver runs
the desktop's SSH manager, resolver, supervisor and RPC session up to the first
config snapshot. Its rerunnable harness lives outside the repository in the
maintainer's scratch directory (`ssh-r5-measure/`). Reconnects are 5 per mode,
each triggered by killing the SSH master; the wake rows freeze only the client
process for 120 s while the link stays up.

| Carrier      | Build                 | Total  | SSH    | After SSH | Commands | `goat` starts | Pairings | First attempt |
| ------------ | --------------------- | ------ | ------ | --------- | -------- | ------------- | -------- | ------------- |
| direct       | before (`1cc858ad3`)  | 8.0 s  | 4.9 s  | 0.26 s    | 1        | 1             | 0        | 5/5           |
| direct       | round 5 (`df83f9eeb`) | 7.6 s  | 4.8 s  | 0.21 s    | 1        | 1             | 0        | 5/5           |
| quick tunnel | before (`1cc858ad3`)  | 8.3 s  | 5.4 s  | 0.23 s    | 1        | 1             | 0        | 5/5           |
| quick tunnel | round 5 (`df83f9eeb`) | 8.8 s  | 6.1 s  | 0.23 s    | 1        | 1             | 0        | 5/5           |
| direct wake  | before (`1cc858ad3`)  | 9.5 s  | 8.2 s  |           | 2        | 1             | 0        | 1/1           |
| direct wake  | wake fold (#461)      | 7.7 s  | 6.3 s  |           | 1        | 1             | 0        | 3/3           |
| tunnel wake  | before (`1cc858ad3`)  | 13.0 s | 11.7 s |           | 2        | 1             | 0        | 1/1           |
| tunnel wake  | wake fold (#461)      | 9.6 s  | 8.4 s  |           | 1        | 1             | 0        | 3/3           |

The quick tunnel adds little per round trip, so the work after SSH stays near
0.2 s on both carriers, and the totals mostly track the remote command. The 7 s
that `macmini-cf` spent after SSH therefore comes from its Access topology,
not from `cloudflared` as such. Against a relay that delays every chunk by
500 ms, the client work after SSH fell from 7.1 s to 5.0 s with #442 (one
descriptor fetch removed; session check and WebSocket ticket overlapped). A
relaunched client with a persisted catalog paired 0 times (#444). Wake rows for
#461 compare against `03ecb78fe`, after #454, whose median was 8.5 s direct and
10.9 s through the tunnel with 2 commands.

### Remaining

- **Client work after SSH on `macmini-cf`.** Re-measure there from a client
  that can reach it. The remaining steps after SSH are a fresh descriptor check,
  the overlapped session check and ticket, the WebSocket, and the first
  snapshot. Carrying the descriptor in the launch answer was rejected: a
  forward can be replaced while its local port is reused, so the client would
  send its bearer before checking who answers.
- **Real sleep.** Wake was measured by freezing the client process, not by
  sleeping a Mac: the measuring Mac hosts the agents and has no
  non-interactive `sudo` to schedule a wake.
- **Cold first connection.** Installing on a fresh user ran 5 remote commands
  and the sampler saw 22–24 `goat` processes start (55.5 s direct, 60.7 s
  through the tunnel), most of them version and helper checks during install.
  Nothing has been compared against an earlier build yet.
- **Windows hosts.** The Windows branches of host download and launch-port
  ownership are covered by fixtures only; no Windows host accepted this
  client's keys.
