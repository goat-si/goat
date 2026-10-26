# ADR-0014 — decision recorded under "Runtime identity"

- Contract owner: [desktop.md](../desktop.md#runtime-identity)
- Issue: goat-si/goat#110

## Decision record

- **Purpose.** Run the desktop app as Electron runtime `GOAT <stage>` on `goat://app` instead of
  `T3 Code <stage>` on `t3code://app`, without losing saved secrets or renderer storage and with a
  working rollback.
- **Before.** Electron names the safeStorage key (macOS Keychain item, Linux Secret Service entry)
  from `app.name` as it stands before the event loop starts. `app.setName("T3 Code <stage>")` ran
  after asynchronous startup work, so in practice the key sat under the initial package name. The
  renderer scheme keyed localStorage and IndexedDB. The profile directory was already GOAT's own
  (`goat-desktop*`) and depends on neither.
- **Alternatives.**
  - Re-encrypt each safeStorage blob through a helper process running under the old name. It only
    covers blobs GOAT knows about (not Clerk's token store), and rewriting the files breaks a
    rolled-back build.
  - Copy the Chromium LevelDB and IndexedDB directories to the new origin. Chromium keys its storage
    buckets internally; a file copy is not a supported format.
- **Decision.**
  - Set `GOAT <stage>` synchronously when `main.ts` loads. Before Electron first uses safeStorage,
    copy the key of the initial package name (or `T3 Code <stage>`) to the new name. All ciphertext
    stays valid for both names. Windows needs nothing: its key sits in the profile, protected by DPAPI.
  - Before the first window, a detached page on each origin exports and imports localStorage and
    every IndexedDB database, never replacing data the new origin holds.
  - Register both schemes with the OS and accept both in link parsers and the server CORS list.
- **Reasons.** Copying the key moves every safeStorage consumer at once and leaves nothing to undo.
  Reading storage through the page uses Chromium's own formats.
- **Tradeoffs.**
  - The KWallet backend on Linux is not covered; its secrets need re-entry.
  - If the copy fails and Electron then creates a fresh key, the next launch logs a conflict and
    keeps both keys; secrets written under the old one need re-entry.
  - The origin copy retries once in the same launch, then lets the window open. After that the app
    creates its own data, which a later import never replaces.
  - A rolled-back build sees data as of the migration, not what the new build wrote afterwards.
  - A desktop from this change needs servers that accept the `goat://app` origin, and a Clerk
    instance that allows the `goat://app/` redirect.

## Legacy readers and their support cutoff

GOAT keeps reading the names that builds before this decision wrote: the safeStorage key copy from the
old runtime name, the renderer-origin copy from the old scheme, the old scheme registration (also used
by prompt links and the Codex auth handoff reader), the old desktop origins in the server's CORS list
and provider auth return URLs, and the old hosted app origin in shared links. Removing any of them
strands installs that update directly from such a build. They go only together, at a support cutoff: a
published minimum version below which a direct update is no longer supported, chosen when the version
telemetry shows almost no installs below it. Until then each stays. New code reads old spellings through
`packages/contracts/src/legacyT3Names.ts`, or on a line marked `goat-rename: legacy` when the name
belongs to one reader.

## Frozen legacy identities

Decided 2026-10-20 in #110, #111 and #112. The names below keep their T3 spelling through the
first stable release. Renaming one is a migration of installed state. It is revisited only together
with a migration that has been verified on real installs, and the rename tooling keeps each one
(`scripts/lib/goat-rename/rules.ts`).

- **Linux desktop entry `t3code.desktop`, `StartupWMClass` `t3code`, and the deb package
  `t3code`.** Docks match windows to pinned launchers, URL handlers and file associations through
  the entry name and WM class, so a rename orphans what users set up. A renamed deb package installs
  next to the old one instead of upgrading it. Nothing users see gets better.
- **Preview browser partitions (`persist:t3code-preview-*`).** Each partition holds the cookies
  and logins of a preview tab. Electron has no supported way to copy a partition, so a rename signs
  every user out of every previewed site.
- **GNOME capture extension uuid `snap-shot@t3.codes`, its D-Bus names
  (`com.t3tools.T3Code.SnapShot`, `/com/t3tools/SnapShot`), and the KDE helper
  `com.t3tools.T3Code.KdeCapture`.** On Wayland, GNOME Shell loads a newly installed extension
  only after the user signs out and back in, so a renamed extension switches capture off for every
  existing user until then. A later rename must keep the old extension working until the new one
  is active.
- **Mobile native names: renamed, device verification pending.** The Expo modules
  (`apps/mobile/modules/goat-*`) and their native views, classes, JNI symbols and resources use
  GOAT names since #1769 (plan 261026 wp6). The rename changes the native fingerprint, so OTA updates
  carrying the new names reach only binaries built with them. The Android notification tags, the
  notification preferences store, the widget-expiry deadline store and the push data key keep their
  legacy spelling (lines marked `goat-rename: legacy`), so posted notifications and saved
  preferences stay where they are. Static checks prove the JS and native names agree; the next
  TestFlight and Android builds verify the rename on devices.
- **SSH runner `run-t3.sh`.** Clients of every version find and reuse the runner on a remote host
  by this name, so an older client would no longer see the runner a newer one installed.
