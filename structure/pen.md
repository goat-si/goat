# Pen

Pen is a mesh of machines that reach each other's loopback ports through relays, outside the GOAT server. GOAT
consumes it only through OpenSSH: `pen ssh-config --install` writes `Host pen-<name>` entries that
[SSH](ssh.md) discovers like any other alias. Decisions and traps are in
[docs/internals/pen.md](../docs/internals/pen.md); the normative wire rules are
`packages/pen-protocol/CONTRACT.md`, which wins over every implementation.

## Components

- `apps/pen` is one Go binary (module `github.com/goat-si/goat/apps/pen`, no `package.json`). `internal/mesh` is
  the signed record log, its view (members, revocations, account binding, lock), joins and sync;
  `internal/session` the Noise IK sessions; `internal/relay` uplinks and the handshake and ping races;
  `internal/daemon` the node process with its control socket, account join, dashboard and presence;
  `internal/relayserver` the Go relay behind `pen relay serve`; `internal/cli` the commands. `apps/pen/install`
  holds `install.sh`, `install.ps1` and the systemd, launchd and Task Scheduler templates; `apps/pen/scripts` the release build and the
  end-to-end scripts.
- `packages/pen-protocol` (`@goat/pen-protocol`) is the contract, the TypeScript codec the Workers share, and
  `vectors/*.json`, which the Go and TypeScript tests both read.
- `infra/pen-relay` is the Cloudflare relay: a Worker and one SQLite Durable Object per node id using WebSocket
  hibernation. It also serves `install.sh` and the binaries from `public/`, which `apps/pen/scripts/build.sh` writes.
- `infra/pen-login` is the Google sign-in service: a Worker and one global Durable Object holding device codes and
  the account-to-mesh registry. It signs 10-minute assertions with `LOGIN_SIGNING_KEY`.

## State

A node keeps its state under `PEN_HOME` (default `~/.pen`, 0700, or an owner-only DACL on Windows): `identity.json` (0600, the node's keys),
`config.json` (name, relays, download relay), `mesh.json` (the record log), `offers.json` (live invites),
`pending.json` (requests waiting for approval in lock mode), `login.json` (the account this machine signed in
with), `versions.json` (each member's last announced protocol version), `forgets.json` (pending registry removals),
`daemon.json` and `daemon.lock` (the running daemon), `state.lock`, `daemon.log` (capped at 4 MiB with
`daemon.log.1`), `dashboard.html` while a dashboard link is unused, `relay-check/` (the keys `pen relay check`
uses), `joined.json` (a mesh `pen login` joined, until the running daemon adopts it), the `left` marker after
`pen leave`, and the control socket `control.sock`. Outside it, `pen ssh-config` writes `~/.ssh/pen/config` and an
`Include` line in `~/.ssh/config`, the daemon keeps members' SSH host keys in `~/.ssh/pen/known_hosts`, and a
service is
`~/.config/systemd/user/pen.service`, `~/Library/LaunchAgents/si.goat.pen.plist` or the Task Scheduler task
`pen-<user>-<hash>`. `pen leave` deletes the keys and
`mesh.json`.

## Checks

goat-ci's `test-pen` task runs whenever a pull request changes one of the four directories above or the files that
define the task (`.github/workflows/goat-ci.yml`, `.github/scripts/goat-ci-scope.cjs`), and in every full run:
`gofmt`, `go vet` and `go test -race` for `apps/pen`, `apps/pen/scripts/installcheck.sh`, `threenode.sh` and
`loginnode.sh` against local relays and a fake login service, and the `@goat/pen-protocol`, `@goat/pen-relay` and
`@goat/pen-login` suites (the Worker suites start `wrangler dev`). `test-pen-windows` runs `go vet`, `go test` and
`installcheck.ps1` on hosted Windows for changes under `apps/pen` or `packages/pen-protocol`. Deploys follow [the runbook](../docs/operations/pen.md).
