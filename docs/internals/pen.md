# Pen

Pen is a GOAT-only mesh: a Go node (`apps/pen`), its wire contract and vectors
(`packages/pen-protocol`), a Cloudflare relay (`infra/pen-relay`), a Go relay (`pen relay serve`, run in
Seoul) and a Google sign-in service (`infra/pen-login`). The [contract](../../packages/pen-protocol/CONTRACT.md)
wins over the code; user workflows are in [Pen](../user/pen.md) and procedures in the
[runbook](../operations/pen.md). This page keeps the decisions and the traps.

## Trust

- **Members trust each other fully.** After the Noise handshake a member dials `127.0.0.1:<port>` for any
  port the peer names (`serveTCP` in `apps/pen/internal/daemon/accept.go`). There is no per-port or
  per-member policy, because a policy would need signed records every member enforces alike and Pen is
  one person's machines. Anything that listens on loopback of a member is reachable by every other member.
- **Relays are untrusted for content, trusted for availability.** They forward Noise records between
  pinned static keys and cannot read, forge, replay or splice them. They see node ids, client addresses,
  record sizes and timing. Close codes are not authenticated, so a hostile relay can end a dial (4401, 4400) or drop it; several relays are the answer to that, not code.
- **The installer trusts the relay that serves it.** `install.sh` (and `install.ps1`) checks the binaries against
  `SHA256SUMS` from the same relay (`apps/pen/install/install.sh`), which proves an intact transfer only.
  Whoever controls the download relay can ship any binary. Publishing checksums somewhere the relay
  operator cannot write (signed release assets) would remove that; it is not done.
- **The login service holds no mesh key.** It asserts only "node key `signPub` belongs to Google account
  `sub`" for 10 minutes. A member verifies the assertion against the login key recorded in the mesh's
  `account` record and signs the `admit` itself, so the service cannot add a machine to a mesh on its
  own, and a mesh keeps working when the service is down. What it can do is admit any machine to an
  unlocked mesh by asserting a false account; `pen lock on` moves that decision to a member.

## Keys that cannot be replaced quietly

- **`LOGIN_SIGNING_KEY`.** Every bound mesh pins the login key's `kid` and public key in its `account`
  record. A new key makes every assertion fail on every existing mesh until one member of each mesh runs
  `pen login` again, which signs a new `account` record with the new key (the rebind path is
  `TestLoginOnAMemberBindsAgainAfterAnUnbindOrAKeyRotation`). That rebind is also the rotation: assertions
  live 10 minutes and members verify against the bound key only, so serving two keys at once would buy
  nothing. The Worker secret cannot be read back, so the only copy outside Cloudflare is the operator's
  backup (see the runbook).
- **A node's identity.** `~/.pen/identity.json` is the node. A relay keeps one uplink per node id and
  closes the older one 4409, and a node that gets 4409 stops instead of reconnecting
  ([contract](../../packages/pen-protocol/CONTRACT.md#relay)). Two machines sharing an identity, such as boxes
  made from an image that contained `~/.pen`, therefore knock each other offline. Never bake `~/.pen`
  into an image; join each machine on its first boot. A startup guard cannot catch a clone by
  `/etc/machine-id`: boxes.dev forks the whole VM, so a box made from the template keeps its machine id
  and even its boot id (checked 2026-11-10). Detecting a clone needs a value the platform makes unique per
  box.

## Revocation and compromise

`pen revoke --compromised` also revokes every key the member admitted, and drops its `account` records
and its lock `off` records while keeping its lock `on` records
([mesh records](../../packages/pen-protocol/CONTRACT.md#mesh-records)). The asymmetry is deliberate:
revoking a stolen machine must never unlock the mesh or keep a binding it signed, and a stray `on` costs
nothing because any member can sign `off` after it. When the stolen machine had signed the binding,
members fall back to the previous binding's login service to send forgets, so it leaves the account's
registry too (`forgetRevoked` in `apps/pen/internal/daemon/account.go`).

`account` and `lock` records stall a v1.0 node, so a member signs one only when every member has announced
`"pen":"1.1"` in a sync hello. The last announced version is kept in `versions.json` so one offline member
that already announced does not block the mesh; a member that never announced still does.

## What lock mode and the registry do not guarantee

- **Lock binds only members that hold it.** Before deciding a Google join a member syncs with every member it
  can reach for up to 5 s, so a lock it slept through still counts. A member that reaches none of the members
  holding the lock decides on its own view and can admit. The same holds for an unbind or a revoke.
- **A served copy can be cut.** The member that admits a new machine chooses which records to send. A revoked
  or stolen machine that the registry still lists could send its own admit and its revokes of the honest
  members. The joiner therefore also syncs with every node the registry listed that its copy does not count
  as a member (`FinishJoin` in `apps/pen/internal/daemon/account.go`). One that refuses it is asked to check
  the joiner's records against its own view (`serveCheck` in `apps/pen/internal/mesh/check.go`); the join
  fails only if it still refuses, which it does when the joiner's admits pass a key its own view revoked
  (plainly or as compromised) before reaching one it counts as a current member. Two honest cases refuse too:
  a machine admitted by a since-revoked key that this node has not heard of yet, which passes once the members
  sync, and a machine whose admit lost to a concurrent revoke of its admitter in the canonical order, which was
  never a member anywhere and must join again (`admittedCleanly` and its tests in `mesh/check_test.go`). Such a
  machine admits nobody: the Google join (after its refresh), the invite (before it is used) and `pen approve` all
  check `mesh.IsMember` before signing, and the refusal carries `notMember` so a Google joiner tries the next
  listed machine. The check and the signature (and the invite's burn, or queueing a request) hold the mesh
  store's lock together (`Store.AppendAsMember`, `Store.DoAsMember`), so a revoke merged in between still stops
  them. `pen ls` on such a machine says it is not a member and how to start over. This protects a join only while an honest listed node answers: a listed node that is offline,
  out of session slots or slower than the 30 s push timeout takes no part, and one older than the check
  (pen 0.2.6 and before) still refuses every joiner it does not know.
- **The registry is not the mesh.** Any node with a valid sign-in for the account registers, even one a locked
  mesh only queued, and any registered node can remove the others from the account's list. One phished
  sign-in can therefore make the service offer new machines only the attacker's node. Members and invites
  are unaffected; the remedy is lock mode plus the reset page. Binding registration to a member's
  signature would close this and is not done. A forget that the service refuses because the revoking
  node is not registered shows in `pen ls` and the dashboard instead of retrying silently.

## Mesh state on disk

`mesh.json` decides what may replace it, because more than one writer can hold a set for it: an older save
of the same store, the store of a mesh this node just left (`replaceMesh`), or another process (`pen join`
or `pen login` while no daemon runs). Under the state lock a save reads the file first: for the same mesh it
writes the union with the file's records (records only grow), for another mesh it writes nothing unless the
store was adopted (`Store.Adopt`), and after the file was removed (`pen leave`) it does not recreate it
(`Store.SaveFile`). `config.json` changes read to write under the same lock (`state.UpdateConfig`).

A merge reaches memory before disk. When the save fails the store knows it holds unsaved records
(`Store.Unsaved`): no sync is acknowledged (4507) until a save succeeds, the daemon retries on every push
and every minute, and `pen ls` shows the error until then. Meanwhile the daemon enforces the view in memory:
a revoke it holds but could not write still closes that peer's sessions, which errs toward the revoke; a
restart before a successful save forgets it until a member sends it again.

A version 1 mesh's record space has no shares: one member can fill it with valid records (3840 ordinary
ones, then revokes to 4096), after which no member can record anything, its own revoke included. `pen up` and
`pen login` now found meshes of the shared epoch ([ADR-0026](../../structure/decisions/ADR-0026-pen-record-quotas.md)):
records have `v` 2, each admission lineage keeps fixed shares chosen from the candidates alone
(`selectShares`), admission is read from the kept admits rather than a record's past, and a hash a kept
record names without its record is kept bare. A version 1 mesh keeps the old rules until it is moved.

## Lock order

Three rounds of review findings came from locks taken in the wrong order or released between a check and
the step it guards. The daemon takes them in this order only, never back:

1. The per-file save mutexes (`Store.saveMu`, `cfgSave`, `versionsSave`): one save of that file at a time.
2. `Daemon.mu` (sessions, presence, `saveErr`), then the store's `Store.mu` (`viewChanged` and
   `register` read the view under `Daemon.mu`). Nothing holding `Store.mu` takes `Daemon.mu`.
3. Under `Store.mu`: the decision callbacks of `Store.AppendAsMember` and `Store.DoAsMember`, which check
   membership, the binding and the lock against the view of that moment, burn an invite (`Invites.mu`) or
   queue a request (`pendingBook.mu`), and sign. `Merged` callbacks run after `Store.mu` is released.
4. The state lock (`state.Lock`, a file lock that also orders other processes) last. A save takes its
   snapshot under `Store.mu`, releases it, then takes the state lock and does not take `Store.mu` again
   while it holds it, since an invite burn holds `Store.mu` while it writes `offers.json`.

`Daemon.meshMu` only guards which store and invite book are current and is never held across a call into them.
`serviceBook.mu` (the registered services) is a leaf: nothing is called while it is held.

## Services

A member's session can reach a program on another member as a service stream (contract "Services"), so the program
learns, with proof, which member is calling. GOAT will be the first such program; nothing registers one yet.

- **Only the control socket registers.** `service.register` and `watch.snapshot` are handled in `handleControl` before
  `do`, and the dashboard only ever calls `do`, so a page on the dashboard's port cannot register a service or read
  the full member list. The control socket is owner-only, which makes "who can register" the same as "who can read
  the node key": the OS user that runs pen.
- **A delivery commits under the registry lock.** After the program's answer verifies and before the identity line is
  written, `serviceBook.commit` checks that the registration is still the current one for its name and records the
  connection on it. Replacement and removal take the same lock, so nothing commits to a registration that has ended,
  and they close every connection already committed to it. A delivery that committed just before a replacement can
  still write its identity line to the old program; the replacement closes that connection right after.
- **The ready line is for services only.** `pen pipe --node --noise @<service>` prints it; the same exact form with a port
  (what `pen-<nodeId>` ssh blocks run) does not, because ssh shows a ProxyCommand's stderr to the person and checks the
  host key itself. `PEN_TRACE` is ignored in the exact form so nothing precedes the ready line.
- **Exact ssh blocks turn reuse off themselves.** The `pen-*` fallback block sets `ControlMaster auto` and matches every
  `pen-` alias, so a `pen-<nodeId>` block that did not say `ControlMaster no` and `ControlPath none` would inherit a shared
  connection that another route may have opened.
- **Close codes prove nothing about delivery.** A 4404 can be "no program", "the program failed the proof" or an
  error after the program read bytes (a splice error maps to 4404). Callers classify by the bytes they wrote.
- **`watch` is frozen.** `pen ls --watch --json` prints its lines verbatim, so the full snapshot with keys and a
  generation is a separate op instead of new members on `watch`.

## Dials

Kind 0x01 sessions (TCP and mesh sync) race the Noise handshake on every relay and confirm only the first
verified message 2, because the first `pong` only proves a relay is up, while the path back from the node
is what costs time. This is safe only because a responder acts after key confirmation. Joins (0x03) and
account sessions (0x04) keep the ping race: their message 1 spends a single-use invite or reserves one
of four account slots, so it must travel on one socket (Doriterm #1351).

## Why a Seoul relay

Requests from Korea to this account's Worker were served at LAX, so a dial between two Seoul machines through the
Worker crossed the Pacific twice: `/healthz` took 0.9 to 1.9 s from Korea against 20 to 30 ms for a Go relay
on an Oracle VM in Chuncheon. With the handshake race, a box in Oregon reaching a Mac in Seoul picks the
Seoul relay on its own, and a forwarded HTTP request fell from about 2.3 s to 0.87 s. The Worker stays first in
the list because it also serves the installer and binaries.

## Dashboard

`pen dashboard` runs on `127.0.0.1` with a random port, and anything on that machine can reach the port.
Cookies are not isolated by port, so the page never uses one: a single-use token arrives in the URL
fragment (from an owner-only file, never a process argument), is exchanged for a bearer kept in
`sessionStorage`, and every response carries an HMAC of that bearer under a per-start key. A tab that
sees a missing or wrong server id, a network error or a timeout stops for good, because a process that takes
the port after the dashboard stops would otherwise be trusted by the open tab. Every action goes through
the same daemon operation as the CLI.

## Byte counters

`pen pipe` and `pen forward` run without the daemon, so the daemon learns their bytes only when they report them over
the control socket (`traffic.report`, contract "Traffic counters"). A report is best effort and silent, because a
pipe is ssh's ProxyCommand: a report must never change its output, its exit code or its stderr. The daemon keeps the
counts in memory only, in fixed buckets with a cap on pairs (`apps/pen/internal/traffic`): losing a day of counts on
restart costs less than another state file whose format must stay readable.

## Bound invites

An invite token is a bearer secret: whoever holds it joins. GOAT admits disposable machines whose keys it already
has, so a bound invite names its subject and the inviter refuses any other card before the burn (`Subject` in
`apps/pen/internal/mesh/bound.go`). The refusal has to come before the burn: a leaked token must not let another
machine use the invite up. The op keeps the member name `subject`, which an older node decodes as the string of
`revoke` and refuses, so a version gap fails closed instead of minting an unbound token.

GOAT must be able to tell afterwards which machine an invite admitted, or that it admitted none. A bound invite is
therefore never deleted silently: its entry becomes `burned` (with the offer nonce the admitted card repeats),
`cancelled` or `expired` in the same save as the event, and stays until GOAT acknowledges it. Each such transition
is computed on a copy and becomes the book only once `offers.json` is written, so a failed save leaves the invite as
it was; an ordinary invite keeps its old behaviour. A bound entry keeps its secret and expiry under `boundSecret` and
`boundExpiresAt` (`inviteFile`), which an older binary does not read: after a downgrade it sees no secret and no expiry,
takes every bound entry for expired and prunes it, instead of admitting any machine with a live bound invite's token. `invite.status`
takes `Store.mu` and then `Invites.mu` (`mesh.StatusOf`), the order of a burn, so it never sees a burn without its
admit; `invite.cancel` and `invite.ack` take `Invites.mu` alone.

## Relay cuts and typed ssh names

A relay can drop a stream, open more sessions than the contract allows, or carry a host name nobody checked. None of
these may look like success to a local program.

- **A cut stream resets the local socket.** A plain close after the relay drops a stream reads as a complete reply.
  `serveTCP`, `serveService` and `pen forward` set linger 0 on a splice error unless `stream.Delivered` says the
  peer's FIN and every byte before it reached the socket, so a cut reads as a reset, and a reply whose last byte the
  socket took before the error ends normally when only the other direction failed. The rule is conservative: a reset
  can drop accepted bytes the program has not read yet, but never ends a short reply cleanly. Stopping a forward or a
  daemon therefore resets connections still open.
  `pen pipe` reports a cut through its exit status.
- **A node bounds its sessions itself.** A relay that keeps the contract holds at most 8 pending and 32 active sessions
  per node, and it sends a session's CLOSE before any later OPEN on the same uplink. The node forgets a session as it
  sends its own CLOSE, so when an OPEN arrives the node holds no more sessions than the relay did when it sent that
  OPEN, well below the uplink's 64 (the node can briefly hold more than the relay does now, until a queued CLOSE
  arrives). Past 64 the node answers OPEN with CLOSE 4429 and stores nothing, so a relay that ignores its caps
  cannot make the node hold a session for every OPEN it sends.
- **Only the `pen-*` fallback guards the typed name.** Unix ssh replaces `%n` with the name as typed and runs
  ProxyCommand in a shell, and before OpenSSH 9.6 it accepts any name. The fallback single-quotes `%n` and its
  `"!*'*"` pattern skips names holding a quote, so the name reaches `pen pipe` as one word. Member blocks match an
  exact, validated name and keep `%n` bare, which is the form GOAT's route check (`penSshRoute.ts`) accepts.
  Win32-OpenSSH starts ProxyCommand without a shell and splits a name with spaces into several arguments, so
  `pen pipe` reads flags only before the node.

## Windows

- **Go's monotonic clock counts sleep on Windows.** It reads the interrupt time, so wall minus monotonic never
  shows a sleep there; the wake check uses `QueryUnbiasedInterruptTime` instead (`awake_windows.go` in
  `apps/pen/internal/daemon`).
- **Mode bits protect nothing on Windows.** The state directory gets a protected DACL with one ACE for the user,
  which its files and the AF_UNIX control socket inherit (`private_windows.go` in `apps/pen/internal/state`).
  Windows checks that DACL when a process connects to the socket; an elevated administrator's backup privilege
  passes it, as root passes 0600 on unix, so no peer check is added.
- **Task Scheduler's restart on failure ignores exit codes.** It restarts only a task that failed to launch, so the
  task runs `pen up --supervise`, which restarts a daemon that exited non-zero. `pen down` writes a `down` record
  that every supervisor checks before it starts the daemon, then waits for the supervisor's lock to come free;
  the supervisor sits in a kill-on-close job, so `schtasks /End` also ends a daemon it was still starting.
  `pen up` removes the record and repeats `schtasks /Run` until the daemon answers, because
  Task Scheduler can still count the old run as running and drop the new one (IgnoreNew). The record outlives a
  sign-in on purpose: a sign-in cannot be told apart from a supervisor that was starting during `pen down`. The task uses the user's
  interactive token, which needs no admin rights and means Pen runs only while that user is signed in; S4U or a
  stored password would need "Log on as a batch job", which standard users lack. schtasks accepts its XML only in
  UTF-16, and expands `%VAR%` in the task's command with no escape, so `pen up` refuses a `pen.exe` path holding
  `%`, as the systemd unit refuses `$`.
- **A refused start ends the supervisor.** `pen up --supervise` follows the `--service` rule: when the stored
  configuration cannot start (a relay list pen no longer accepts, or the node left), it exits 0 and writes the reason
  to `daemon.log` and `start-refused`; it runs the daemon as `pen up --foreground --service`, so a daemon that
  refuses its start ends the loop instead of being restarted. `pen up` removes `start-refused`, writes a random
  id to `start-request` and runs the task; the supervisor reads that id before its checks and passes it to its
  daemon, the refusal starts with it, and `pen up` fails at once only with a refusal carrying its own id, so a late
  refusal of an earlier start is not taken for this one. `pen up`, `pen down` and `pen leave` take turns on
  `start.lock` (not the state lock, which the starting daemon needs); `pen down` and `pen leave` take it before
  they look for a task or a daemon, and `pen down` writes the `down` record even when nothing runs. Two `pen up`
  at once each see the refusal of their own start, and a `pen down` during a start runs after the start is
  decided, so whichever finishes last decides whether Pen runs. Everything done while holding the turn is
  bounded: a status or stop request on the control socket 2 s, each `schtasks` run 15 s (then that process is
  ended), the readiness wait 20 s, the leave request 1 min. A start holds the turn at most about 1 min, a
  `pen down` 1.5 min, a `pen leave` 3 min; a command that waits longer than 3 min 10 s for the turn fails and
  names the command holding it (`start.holder`). The same control-socket and command bounds apply to `pen up`,
  `pen down` and `pen leave` on macOS and Linux (`systemctl` and `launchctl` runs).
  - What a bound cut short means: a status answer slower than 2 s from a busy but healthy daemon makes `pen up`
    try a start (on Windows it registers the task again and runs it, which the running supervisor ignores, and
    reports that the daemon did not start) or makes `pen down` report that the daemon did not stop; repeating
    the command is safe. A `schtasks`, `systemctl` or `launchctl` run cut off at 15 s may or may not have taken
    effect; the next command does not trust it: `pen up` registers the task (or rewrites the unit) and starts it
    again and waits for the daemon to answer, `pen down` decides by whether the supervisor and daemon locks are
    free, and `pen leave` looks for the task with `schtasks /Query` (or the unit file) before it removes it.
  - `pen leave` waits 1 min for the daemon's leave. The daemon finishes a leave it has begun even when its client
    stopped waiting (the revoke may already be signed and pushed), and refuses a second leave meanwhile; so a
    `pen leave` that runs out says the leave is still in progress and keeps the service. A request that never
    reached the daemon (its write timed out) is reported as such: nothing changed. The daemon writes the `left`
    marker before it deletes `identity.json`, `mesh.json` and `offers.json`; a delete that fails (a reader
    holding the file on Windows) is reported by name and the service is kept. A later `pen leave` that finds the
    marker and no daemon deletes what is left (`FinishLeave`, under the state lock, the code the daemon uses)
    and removes the task or unit only once those files are gone. `FinishLeave` looks at the marker again under
    the lock and deletes nothing without it; `pen up`, `pen join` and `pen login` clear the marker and make the
    new identity in one hold of that lock (`EnsureIdentityClearing`), so a resumed leave cannot delete a node
    started meanwhile (it says the node is not leaving). It refuses while a daemon holds `daemon.lock`. A `pen leave` that finds no Pen identity and no
    marker removes only the task or unit, no state files, and says "no Pen identity in <folder>", so a folder
    that is missing or not mounted is not taken for a node that left. This holds on macOS and Linux too.
  - A command that has to wait for the turn says so at once, naming the holder from `start.holder`.
  - With `PEN_HOME` set there is no task and no turn (Pen runs detached), so a `pen down` that overlaps a
    `pen up` can find nothing to stop while the start completes; run `pen down` again.
- **A pending AF_UNIX read may miss the other side's close.** One Windows CI hang suggests that a blocked read of the
  control socket may never return after the peer half-closes; 900 probe rounds on the hosted runner did not reproduce
  it. So no read of a registration waits without a bound: both sides give way to a fresh read every 30 s, and
  `pen service register` stops waiting for the node's close 30 s after its own half-close. That bound needs no close
  notice: at a read's deadline Go cancels it with `CancelIoEx` and waits for the cancelled read to complete
  (internal/poll `cancelIO`), so it ends a read the driver left pending once the driver completes the cancel, and
  would not end one whose completion Go itself lost. Whether a fresh read sees a close the pending one missed is not
  established, so the node's end of a registration whose holder is gone may still wait for a failed write, a newer
  registration or the daemon's stop. GOAT ends its child's stdin and kills it at once, so only the node ends GOAT's
  registration.
- **A file another process holds open cannot be renamed over.** Go opens files without `FILE_SHARE_DELETE`, so
  while a reader has `mesh.json` or `config.json` open, replacing it fails with `ERROR_ACCESS_DENIED`. Saves retry
  that error (and a sharing violation) for up to 2 s while they hold the state lock, the rule of Go's
  `cmd/internal/robustio`; past that the save fails and the file keeps its old content whole. A stale writer cannot
  win meanwhile: every write of those files reads the current file under the state lock (`LockFileEx`, which a
  second handle in the same process also waits for) and decides from it.
  Readers such as `pen pipe` and `pen forward` take no lock, so parallel ProxyCommands never queue; an open that
  lands during a replace can fail the same way, and `ReadJSON` retries it by the same rule (a missing file at once).
- **Win32-OpenSSH starts ProxyCommand without a shell.** The command is quoted for CreateProcess, the state
  directory travels as `pen pipe --home`, and the config has no ControlMaster, which that ssh lacks.
- **An sshd session's job ends its processes.** A `--no-service` daemon started over SSH tries to leave the job
  (CREATE_BREAKAWAY_FROM_JOB) and stays in it when the job forbids that; the task is the background path.
