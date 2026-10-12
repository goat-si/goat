# Desktop

`apps/desktop` (`@goat/desktop`) is the Electron host. `apps/desktop/package.json` points `main`
at `dist-electron/boot.cjs`. The main process source is `apps/desktop/src/main.ts`, which composes
the desktop layers and runs `DesktopApp.program`.

The packaged renderer is the built web app. `apps/desktop/src/app/DesktopEnvironment.ts` serves it
on the `t3code://app` scheme (`apps/desktop/src/electron/ElectronProtocol.ts` also registers
`t3code-dev`). `APP_BASE_NAME` in that file is `"GOAT"`. `DESKTOP_RUNTIME_APP_BASE_NAME` stays
`"T3 Code"` so saved SSH credentials that key off the Electron runtime name remain readable.

## Shell

The bundled server entry is `backendEntryPath` in `apps/desktop/src/app/DesktopEnvironment.ts`:
the server root joined with the built `bin.mjs`. A packaged build reads that tree from
`resources/server.asar`. `DesktopBackendManager` in
`apps/desktop/src/backend/DesktopBackendManager.ts` spawns the server child and probes readiness at
`/.well-known/t3/environment`. The renderer then uses the same WebSocket RPC as a browser. It does
not import the server's orchestration modules.

`apps/desktop/src/preload.ts` exposes `window.desktopBridge`. SSH host discovery for the shell is
`apps/desktop/src/ssh/DesktopSshEnvironment.ts`, which calls `packages/ssh`.

Where the desktop process stores server state is the [state roots](settings-and-storage.md#state-roots)
contract: `~/.goat/desktop` for a packaged build, `~/.t3` for a development build unless
`GOAT_HOME` is set.

> Decision record: [ADR-0004](decisions/ADR-0004-electron-shell.md)
