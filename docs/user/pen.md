# Pen

Pen joins your machines into a private mesh. Each machine gets a name, and any member can reach a
local port on any other member through an end-to-end encrypted pipe, even when neither machine
accepts incoming connections. GOAT uses this to reach a machine over SSH as `pen-<name>`, so a
laptop, a home server and a cloud box can work together without a VPN, port forwarding or a public
address.

Pen runs as a small command-line program and background service on each machine. Traffic passes
through relays, which forward it without being able to read it.

## Before you start

- Pen runs on macOS and Linux (x86-64 and ARM). Windows machines cannot join a mesh.
- Every member trusts every other member fully: a member can open any port that listens on
  `127.0.0.1` of another member, as if it were local. Add only machines you control, and remove a
  machine you no longer trust (see [Remove a machine](#remove-a-machine)).
- Installing downloads Pen from the relay that serves it and checks the download against the
  checksums the same relay publishes. That proves the file arrived intact; it does not protect you
  from the relay's operator.

## Install Pen

```sh
curl -fsSL https://pen-relay.pos090001.workers.dev/install.sh | sh
```

This puts `pen` in `~/.local/bin` and prints what to run next. It does not start or join a mesh.
To install and connect in one step, add one of these after `sh -s --`:

| Option           | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `--login`        | Sign in with Google and join your account's mesh, or start one. |
| `--join <token>` | Join the mesh an invite token comes from.                       |
| `--up`           | Start a new mesh with this machine as its first member.         |
| `--name <name>`  | Name this machine (with any of the three above).                |

For example: `curl -fsSL https://pen-relay.pos090001.workers.dev/install.sh | sh -s -- --login`.

## Sign in with Google

`pen login` (or `install.sh --login`) prints a short code and an address. Open the address in any
browser, type the code, and sign in with Google. The page shows the machine's name and fingerprint;
check them against the terminal before you add it.

The first machine you sign in starts a mesh for your Google account. Each later machine you sign in
with the same account joins that mesh: Pen shows the account's mesh and members and asks you to
confirm (`--yes` skips the question). A member must be online to admit the new machine; if none is,
`pen login` says so and retries every 5 seconds until the sign-in expires after 10 minutes. With
the mesh locked, it waits up to 30 minutes for approval.

`pen logout` removes this machine from your account's machine list. It stays in the mesh.
`pen account unbind`, on any member, turns Google sign-in off for the mesh; invites keep working.

The account's machine list is kept by the sign-in service, and it only decides which mesh a new
machine is offered. Anyone who signs in to your Google account, even once, can add a machine to that
list or remove the others from it, so new machines might be offered the wrong mesh; machines already
in your mesh and invites are not affected. If that may have happened, turn on `pen lock on` so new
machines need your approval, change your Google password, clear the list from the reset link on the
sign-in page, and run `pen login` on one of your machines to register your mesh again.

## Require approval for new machines

`pen lock on` makes every newly signed-in machine wait for approval. Its `pen login` names the
member that holds the request and prints the new machine's fingerprint. On that member, run
`pen approve` to list requests, and `pen approve '<fingerprint>'` with the full fingerprint you
read on the new machine to admit it. `pen deny <id>` refuses a request for 24 hours. `pen lock off`
returns to automatic admission.

Lock the mesh if someone else might be able to sign in to your Google account, or as soon as a
signed-in machine is lost.

## Join with an invite

Invites work with or without Google sign-in. On a member, `pen invite --auto` prints a token that
works once within 10 minutes. On the new machine:

```sh
curl -fsSL https://pen-relay.pos090001.workers.dev/install.sh | sh -s -- --join <token>
```

The token is a secret until it is used: anyone holding it can join in its place.

## Use your machines from GOAT

Run `pen ssh-config --install` on the machine where GOAT runs. It adds an SSH host
`pen-<name>` for every member, with the member's login user and host keys, and keeps the list
current as machines join or leave. GOAT finds these hosts like any other SSH host, so you can
[open projects and start work](./remote-access.md#desktop-managed-ssh) on a member by choosing
`pen-<name>`. `pen ssh-config --uninstall` removes them.

An SSH connection stays open for 10 minutes after you close it, so the next `ssh pen-<name>` starts
almost at once. `ssh -o ControlPath=none pen-<name>` opens a separate connection.

To reach another port, `pen forward 8080 <member>:8080` listens on this machine's port 8080 and
connects each connection to port 8080 on the member.

## Dashboard

`pen dashboard` opens a page in your browser, served by Pen on this machine, that shows the mesh:
members with their status and how each joined, relays and their health, pending approvals, and
recent changes. You can approve or deny requests, remove members, lock the mesh, change relays
and create invites from it. It is in Korean and English.

The link works once and only on this machine. Run `pen dashboard` again for a new one, for example
after Pen restarts. `pen dashboard --stop` closes the page and signs out every open tab.

## Remove a machine

| Command                             | Use it when                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pen leave`                         | You are retiring this machine. It leaves the mesh and deletes its keys.                                                                                                                                                                                                                                                                                                                                                                                               |
| `pen revoke <member>`               | A machine should no longer be a member. Every member refuses it from then on.                                                                                                                                                                                                                                                                                                                                                                                         |
| `pen revoke <member> --compromised` | A machine was lost or stolen, even if it already left. Also removes every machine it admitted, and its unlocks and account changes stop counting. It prints which machine it revokes; when a machine that left and a current one share the name, it stops and prints a command naming each by its fingerprint. A name, a node id (or its first 4 or more characters) and a fingerprint (or its first 8 or more digits) all work, as long as only one machine matches. |

After `--compromised` on a mesh with Google sign-in, Pen tells you what else to do: turn on
`pen lock on`, change your Google password, and clear your account's machine list from the reset
link on the sign-in page.

## Relays

Each machine keeps a connection to every relay in its list and uses whichever answers first, so one
relay going down does not cut the mesh. An install gets the relays the release lists, and invites
carry the inviting machine's list. `pen relay ls` shows the list; `pen relay add <url>` and
`pen relay rm <url>` change it. Relays must use `https`.

A relay run with `pen relay serve` keeps at most 16 MiB of undelivered data for each internet
address, so machines behind one home or office connection share it: about four sessions whose
receiving side has stopped reading for a while fill it. When that share, or the whole relay, is full,
the relay ends sessions that have taken no data for a couple of seconds, longest first; a session
that keeps reading is not ended for someone else, though data that finds no room is dropped and ends
its own session. An ended session shows as a dropped connection or code 4408; open it again, and Pen
picks a relay again. A machine whose relay connection was ended reconnects by itself and stays
reachable through its other relays.

You can run your own relay with `pen relay serve` on a machine with a public address; see
`pen help`.

## Running Pen in the background

`pen login`, `pen join` and `pen up` install a user service (systemd on Linux, launchd on macOS)
where they can, so Pen comes back after a restart. With `--no-service`, Pen runs in the background
until the machine restarts; run `pen up` again afterwards. `pen down` stops it.
Pen writes its log to `~/.pen/daemon.log` (on Linux with a service, to the user journal) and keeps
it under 4 MiB, with the previous part in `daemon.log.1`.

## Cloud boxes and images

Install and join each box on its first boot with `--login --yes` or `--join`. Never copy `~/.pen`
into an image or template: every box made from it would share one identity, and they would keep
pushing each other off the relays.

On a box that already belongs to a mesh, run `sudo loginctl enable-linger $USER` so Pen's user
service keeps running without a login. If your platform runs a startup script when a box starts or
wakes (on boxes.dev, the project's startup script), this one brings Pen back and never starts a new
mesh:

```sh
#!/bin/sh
[ -f "$HOME/.pen/mesh.json" ] && [ -x "$HOME/.local/bin/pen" ] || exit 0
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
systemctl --user start pen || "$HOME/.local/bin/pen" up
```

Do not take a template snapshot of a box after it joined. Platforms such as boxes.dev copy the whole
machine, including `/etc/machine-id`, so a box made from that snapshot starts as the same Pen machine
and the two push each other off the relays. If that happens, on the copy run `pen down`, delete
`~/.pen` and join again; `pen leave` there would remove the original machine too, since both hold
the same keys.

## Not supported

- Direct connections between machines: all traffic goes through a relay.
- Windows machines as members.
- Managing Pen from GOAT's settings; use the `pen` command or its dashboard.
- Signing in with a Google account the Pen sign-in service does not allow yet. While the service is
  in testing, only listed accounts can sign in; invites work for everyone.
