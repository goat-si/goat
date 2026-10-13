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

## Shared connection catalog

GOAT, GOAT (Nightly), and development builds share one GOAT home, so they share the saved
connection catalog, `connection-catalog.json` in its state directory. Each runtime name has its
own safeStorage key, so a catalog one channel saved does not decrypt through another channel's
`safeStorage`. `apps/desktop/src/app/DesktopConnectionCatalogStore.ts` then asks
`apps/desktop/src/app/DesktopSafeStorageSiblingKeys.ts`, which reads the other channels' keys from
the same key store and decrypts with Chromium's OSCrypt scheme. macOS asks once before an app may
read another app's key. The renderer replaces a catalog it cannot parse, so the store serves only
plaintext that decodes as a connection catalog, whichever key opened it. A wrong key can decrypt to
valid padding, so a non-catalog from this app's key also tries the sibling keys.

- **Recovered.** The original file is copied to `connection-catalog.<channel>.backup.json`, then
  re-encrypted under this app's key. The other channel may be running and saving, so when the file
  changed while it was being recovered, the store reads it again and the newer catalog wins.
- **Unreadable.** A file no key opens (`locked`) or that is not a valid catalog (`damaged`)
  stays in place, and a copy of its exact bytes goes to
  `connection-catalog.unreadable-<hash>.backup.json`, never replacing a different file. Reads
  fail. A `locked` file is not retried against sibling keys until the app restarts, so a refused
  prompt does not repeat. Settings → Connections, a launch toast, and the first-run recovery
  screen explain where both files are
  (`apps/web/src/components/desktop/ConnectionCatalogUnreadableNotice.tsx`). Start fresh saves an
  empty catalog, since a missing file would re-import the legacy saved environments.
- **Writes.** `set` and `clear` read the file on disk first. One this app cannot open is copied
  before it is replaced, and the change is refused when no copy can be made.

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
