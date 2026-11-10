# pen

`pen` gives each machine a key-derived name and an end-to-end encrypted byte pipe to every other member of its mesh,
through relays that see only ciphertext. The wire rules are in [CONTRACT.md](../../packages/pen-protocol/CONTRACT.md).

## Join a machine

On a member: `pen invite --auto` prints a single-use token. On the new machine:

```sh
curl -fsSL https://pen-relay.pos090001.workers.dev/install.sh | sh -s -- --join <token>
```

`pen ls` lists members, `pen revoke <member>` removes one, `pen leave` removes this machine.

## Sign in with Google

```sh
curl -fsSL https://pen-relay.pos090001.workers.dev/install.sh | sh -s -- --login
```

or `pen login` on an installed machine. It prints a code: open the address it shows, type the code and sign in with
Google. The first machine of an account founds a mesh and binds it to that account; later machines see the account's
mesh and its members, confirm, and join without an invite. `pen ls` marks each member admitted this way and announces
it for 7 days.

`pen lock on` makes every new machine wait: its `pen login` names the member that queued it and prints its fingerprint,
and you admit it there with `pen approve '<fingerprint>'` (`pen approve` alone lists requests, `pen deny` refuses one
for 24 hours). `pen account unbind` turns Google sign-in off for the mesh, and `pen logout` removes this machine from the
account's list without leaving the mesh. The login service is trusted to say which Google account a machine belongs to;
lock mode means a member decides instead.

## SSH and GOAT

`pen ssh-config --install` writes `~/.ssh/pen/config` (one `Host pen-<name>` per member with `ProxyCommand pen pipe %n 22`,
the member's login user and its signed host keys) and puts an `Include` for it first in `~/.ssh/config`. The daemon keeps it
current as members join. `pen ssh-config --uninstall` removes both.

## Relays

A node keeps an uplink on every relay in its list (`pen relay ls|add|rm`, or `pen up --relay a --relay b`); dials race all
of them and use the first that answers. Invites carry the inviter's list.

`pen relay serve` runs a relay that speaks the same contract as `infra/pen-relay`:

```sh
pen relay serve --listen <public-ip>:443 --autocert <host> --cache ~/pen-relay/acme
```

`--autocert` gets a Let's Encrypt certificate for `<host>` over TLS-ALPN on port 443 (an sslip.io name of the public IP
works without DNS). Run it as an unprivileged user with `AmbientCapabilities=CAP_NET_BIND_SERVICE` in a systemd unit.
Behind a TLS terminator use `--plain --public-origin wss://<host>`.

## Build

`scripts/build.sh <version> <relay URL>` cross-compiles the binaries into `infra/pen-relay/public/dl/<version>/` with
`SHA256SUMS`, `NOTICE` and `install.sh`; deploying the Worker serves them. `go test ./...` runs the tests;
`scripts/threenode.sh` checks three nodes end to end against local relays.
