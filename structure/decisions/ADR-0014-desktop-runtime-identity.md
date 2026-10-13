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
