# Desktop

`apps/desktop` (`@goat/desktop`) is the Electron host. `apps/desktop/package.json` points `main`
at `dist-electron/boot.cjs`. The main process source is `apps/desktop/src/main.ts`, which composes
the desktop layers and runs `DesktopApp.program`.

The packaged renderer is the built web app, served on `goat://app` (`goat-dev://app` in
development) by `apps/desktop/src/electron/ElectronProtocol.ts`.

## Runtime identity

The Electron runtime name is `GOAT <stage>` (`DESKTOP_RUNTIME_APP_BASE_NAME` in
`apps/desktop/src/app/DesktopEnvironment.ts`). Electron reads it once, before the event loop
starts, to name the safeStorage key that encrypts saved connections and Clerk tokens, so
`apps/desktop/src/main.ts` sets it synchronously at load. The renderer origin keys localStorage and
IndexedDB. Builds before #110 set the name too late, so their key sits under the initial package
name, and they served `t3code://app`. Both migrate forward once per profile and leave the originals
for a rolled-back build:

- `apps/desktop/src/app/DesktopSafeStorageKeyMigration.ts` copies the key of the initial package name
  (or `T3 Code <stage>`) to the new name before anything reads safeStorage (macOS Keychain, Linux
  Secret Service; Windows keeps its key in the profile). A differing key already under the new
  name is logged as a conflict and left alone. Marker: `safe-storage-key-migrated` in the profile.
- `apps/desktop/src/app/DesktopRendererOriginMigration.ts` copies localStorage and every IndexedDB
  database from the legacy origin before the first window, never replacing existing data. Marker:
  `renderer-origin-migrated`.

The OS hands both `goat` and `t3code` links to the app (`getDesktopLinkSchemes`), and the server
accepts both renderer origins (`DESKTOP_RENDERER_ORIGINS` in `apps/server/src/httpCors.ts`).

> Decision record: [ADR-0014](decisions/ADR-0014-desktop-runtime-identity.md)

## Shell

The bundled server entry is `backendEntryPath` in `apps/desktop/src/app/DesktopEnvironment.ts`:
the server root joined with the built `bin.mjs`. A packaged build reads that tree from
`resources/server.asar`. `DesktopBackendManager` in
`apps/desktop/src/backend/DesktopBackendManager.ts` spawns the server child and probes readiness at
`/.well-known/goat/environment`. The renderer then uses the same WebSocket RPC as a browser. It does
not import the server's orchestration modules.

`apps/desktop/src/preload.ts` exposes `window.desktopBridge`. SSH host discovery for the shell is
`apps/desktop/src/ssh/DesktopSshEnvironment.ts`, which calls `packages/ssh`.

Where the desktop process stores server state is the [state roots](settings-and-storage.md#state-roots)
contract: `~/.goat/desktop` for a packaged build, `~/.t3` for a development build unless
`GOAT_HOME` is set.

> Decision record: [ADR-0004](decisions/ADR-0004-electron-shell.md)
