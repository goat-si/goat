import { migratingStorage } from "@goat/client-runtime/storage-migration";
// Keep one reload per build, including failures after boot.
const CHUNK_RELOAD_GUARD_KEY = "goat:chunk-load-reloaded";

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build = import.meta.env.APP_VERSION,
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = migratingStorage(getStorage());
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === build;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, build);
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
