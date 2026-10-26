import { migratingStorage } from "@goat/client-runtime/storage-migration";
// Split chunks are fetched lazily, so a deploy (or desktop server swap)
// between page load and a later fetch can 404 the old hashed assets. One
// reload picks up the fresh index.html. A sessionStorage flag keeps a
// persistent failure from becoming a reload loop, and a successful boot clears
// it so the next stale deploy gets its own single reload.
const CHUNK_RELOAD_GUARD_KEY = "goat:chunk-load-reloaded";

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = migratingStorage(getStorage());
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === "1";
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, "1");
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

export function clearChunkReloadGuard(getStorage: () => Storage = () => window.sessionStorage) {
  try {
    migratingStorage(getStorage()).removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {
    // Blocked storage never held the flag.
  }
}
