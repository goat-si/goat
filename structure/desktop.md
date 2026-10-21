# Desktop

`apps/desktop` (`@goat/desktop`) is the Electron host. `apps/desktop/package.json` points `main`
at `dist-electron/boot.cjs`. The main process source is `apps/desktop/src/main.ts`, which composes
the desktop layers and runs `DesktopApp.program`.

The packaged renderer is the built web app, served on `goat://app` (`goat-dev://app` in
development) by `apps/desktop/src/electron/ElectronProtocol.ts`.

## Runtime identity

The Electron runtime name is `GOAT <stage>` (`DESKTOP_RUNTIME_APP_BASE_NAME` in
`apps/desktop/src/app/DesktopEnvironment.ts`). Electron reads it once, before the event loop
starts, to name the safeStorage key that encrypts saved connections and stored Clerk tokens, so
`apps/desktop/src/main.ts` sets it synchronously at load. The renderer origin keys localStorage and
IndexedDB. Builds before #110 set the name too late, so their key sits under the initial package
name, and they served `t3code://app`. Both migrate forward once per profile and leave the originals
for a rolled-back build:

- `apps/desktop/src/app/DesktopSafeStorageKeyMigration.ts` copies the key of the initial package name
  (or `T3 Code <stage>`) to the new name before anything reads safeStorage (macOS Keychain, Linux
  Secret Service; Windows keeps its key in the profile). A differing key already under the new
  name is logged as a conflict and left alone. Marker: `safe-storage-key-migrated` in the profile.
  On macOS Electron's item is service `<name> Safe Storage` with account `<name> Key`, and a
  packaged build's initial name is the staged package name `t3code` on every channel.
- `apps/desktop/src/app/DesktopRendererOriginMigration.ts` copies localStorage and every IndexedDB
  database from the legacy origin before the first window, never replacing existing data. Main
  relays bounded chunks between a page on each origin; it must never hold the whole origin, which
  can be 100+ MB of blobs and aborts main with a V8 OOM. Marker: `renderer-origin-migrated`; an
  attempt that died leaves `renderer-origin-migration-attempt`, and the next launch marks it
  aborted instead of retrying.

The OS hands both `goat` and `t3code` links to the app (`getDesktopLinkSchemes`), and the server
accepts both renderer origins (`DESKTOP_RENDERER_ORIGINS` in `apps/server/src/httpCors.ts`).
The Linux desktop entry and WM class, the preview partitions and the Linux capture extensions keep
their T3 names through the first stable release (ADR-0014, "Frozen legacy identities").

> Decision record: [ADR-0014](decisions/ADR-0014-desktop-runtime-identity.md)

`apps/desktop/src/app/DesktopClerk.ts` keeps Clerk inactive through `@goat/shared/goatConnect`; GOAT Connect is coming soon.

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

## Computer use host

When the server asks for a Cua Driver host on the private control pipe, the Electron main process
owns it (`apps/desktop/src/cua/DesktopCuaDriver.ts`), so macOS attributes Accessibility and Screen
Recording to GOAT rather than to the server child. On macOS it checks both permissions before
starting and reports `unavailable` until they are granted. Packaged builds start the driver from
`resources/cua-driver`; development builds need `GOAT_CUA_DRIVER_PATH`. The host reuses a running
driver, retires a crashed one, and passes the same telemetry and update-check opt-outs as the
standalone host ([server.md](server.md#computer-use)).

`stageCuaDriverExecutable` in `scripts/build-desktop-artifact.ts` downloads the pinned archive,
checks its size and SHA-256, and stages only the executables: the universal binary on macOS, the
driver, cursor theme tool and Wayland helper on Linux, and the driver, UIA worker and cursor theme
tool on Windows. The SDK's native libraries come from `@trycua/cua-driver` and are unpacked beside
`app.asar`; `patches/@ubjs__node@0.31.0-3.patch` makes the SDK loader find them there. The license
notices are vendored in `apps/desktop/src/cua/notices/`.

## Shell

The bundled server entry is `backendEntryPath` in `apps/desktop/src/app/DesktopEnvironment.ts`:
the server root joined with the built `bin.mjs`. A packaged build reads that tree from
`resources/server.asar`. `DesktopBackendManager` in
`apps/desktop/src/backend/DesktopBackendManager.ts` spawns the server child and probes readiness at
`/.well-known/goat/environment`. The renderer then uses the same WebSocket RPC as a browser. It does
not import the server's orchestration modules.

`apps/desktop/src/preload.ts` exposes `window.desktopBridge`. SSH host discovery for the shell is
`apps/desktop/src/ssh/DesktopSshEnvironment.ts`, which calls `packages/ssh`.
The shell forwards suspend, resume, and screen-unlock events through
`DesktopBridge.onSystemWake`: renderer visibility alone cannot detect lid sleep.
The shared supervisor owns cancellation and retry policy; see
[SSH reconnect](../docs/internals/ssh-reconnect.md#resuming).

Where the desktop process stores server state is the [state roots](settings-and-storage.md#state-roots)
contract: `~/.goat/desktop` for a packaged build, `~/.t3` for a development build unless
`GOAT_HOME` is set.

> Decision record: [ADR-0004](decisions/ADR-0004-electron-shell.md)
