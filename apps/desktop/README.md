# apps/desktop — GOAT 2 Electron shell (lane G)

Main owns windows only (`structure/10_processes.md`). It starts `goat2-host`, keeps it running, and ends
it with its whole process group on quit: quitting the app ends the work.

## Host contract (owner, 2026-11-28)

| | |
|---|---|
| Start | `goat2-host` with env `GOAT2_DATA_DIR`, `GOAT2_HOST_PORT`, `GOAT2_HOST_TOKEN` (random per app launch). No flags. Own process group. |
| Start line | first JSON line on stdout: `{wsUrl, mcpUrl, port, generation}` |
| Ready | `GET http://127.0.0.1:<port>/health` returns 200 |
| Quit | SIGTERM to the group, SIGKILL after 5 s |
| Shell gone | host exits when its stdin closes (host side) |
| Crash | shell kills the dead host's leftover group, restarts with GOAT v1's backoff (1 s .. 30 s jittered, 5 restarts per 10 min, then paused; menu **Start Host** retries) |
| Leftovers from an earlier run | host kills the group recorded in `host.json` on start (host side) |
| Renderer | preload gives `window.goat2Host = {wsUrl, token}`; the UI talks to the host directly |

## Dev build identity

`/Applications/GOAT 2 (Dev).app`, bundle id `si.goat.goat2.dev`, data `~/.goat2-dev` (Electron's own state in
`~/.goat2-dev/desktop`, logs in `~/.goat2-dev/logs/{desktop,host}.log`), host port 3873. The title bar and
About show the branch and commit the app was built from.

## Commands

```sh
scripts/build-dev-app.sh            # build host (release) + web + shell, install, relaunch if it was open
scripts/build-dev-app.sh --no-install
pnpm --filter @goat2/desktop test   # supervisor tests with a fake host
pnpm --filter @goat2/desktop dev    # unpackaged: target/debug/goat2-host + apps/web/dist (GOAT2_WEB_URL for vite)
```

Launching from a GOAT thread: GOAT exports `ELECTRON_RUN_AS_NODE=1`; unset it (`env -u ELECTRON_RUN_AS_NODE`).
