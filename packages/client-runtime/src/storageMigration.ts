import { legacyStorageKey } from "@goat/contracts/legacyT3Names";

export const REMOVED_STORAGE_VALUE = "__goat_storage_removed_v1__";

type StorageAdapter<R = unknown> = {
  getItem: (key: string) => string | null | Promise<string | null>;
  setItem: (key: string, value: string) => R;
  removeItem: (key: string) => R;
};
type SyncStorage = Omit<StorageAdapter<void>, "getItem"> & {
  getItem: (key: string) => string | null;
};
type AsyncStorage = Omit<StorageAdapter<Promise<void>>, "getItem"> & {
  getItem: (key: string) => Promise<string | null>;
};
const wrappers = new WeakMap<object, StorageAdapter>();

/** Read GOAT first, adopt old values once, and leave the old keys intact for rollback. */
export function migratingStorage(storage: SyncStorage): SyncStorage;
export function migratingStorage(storage: AsyncStorage): AsyncStorage;
export function migratingStorage<R>(storage: StorageAdapter<R>): StorageAdapter<R>;
export function migratingStorage(storage: StorageAdapter): StorageAdapter {
  const cached = wrappers.get(storage);
  if (cached) return cached;
  // Async backends run one operation per key at a time, so a pending adoption can never
  // land after a later write or clear.
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, operation: () => T): T => {
    const previous = queues.get(key);
    const result =
      previous === undefined ? operation() : (previous.then(operation, operation) as T);
    if (result instanceof Promise) {
      const settled: Promise<unknown> = result.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, settled);
      void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key);
      });
    }
    return result;
  };
  const adopt = (key: string, value: string | null) => {
    if (value !== null) {
      // A quota failure must not hide readable legacy data. Retry on the next read.
      try {
        const write = storage.setItem(key, value);
        if (write instanceof Promise)
          return write.then(
            () => value,
            () => value,
          );
      } catch {
        // Reads still work when storage is read-only.
      }
    }
    return value;
  };
  const fallback = (key: string, value: string | null) => {
    if (value !== null)
      return value === REMOVED_STORAGE_VALUE && legacyStorageKey(key) !== undefined ? null : value;
    const legacy = legacyStorageKey(key);
    if (legacy === undefined) return null;
    const old = storage.getItem(legacy);
    return old instanceof Promise ? old.then((value) => adopt(key, value)) : adopt(key, old);
  };
  const getItem = (key: string) =>
    serialized(key, () => {
      const current = storage.getItem(key);
      return current instanceof Promise
        ? current.then((value) => fallback(key, value))
        : fallback(key, current);
    });
  const setItem = (key: string, value: string) =>
    serialized(key, () => {
      try {
        return storage.setItem(key, value);
      } catch (error) {
        // Over quota, the retained legacy copy of this key is what crowds out the current
        // value (a write used to replace it in place): drop that copy and retry once.
        const legacy = legacyStorageKey(key);
        if (legacy === undefined || storage.getItem(legacy) === null) throw error;
        storage.removeItem(legacy);
        return storage.setItem(key, value);
      }
    });
  const wrapper = {
    getItem,
    setItem,
    // Removing only the new key would resurrect its retained legacy value on reload.
    removeItem: (key: string) =>
      serialized(key, () =>
        legacyStorageKey(key) === undefined
          ? storage.removeItem(key)
          : storage.setItem(key, REMOVED_STORAGE_VALUE),
      ),
  };
  wrappers.set(storage, wrapper);
  wrappers.set(wrapper, wrapper);
  return wrapper;
}
