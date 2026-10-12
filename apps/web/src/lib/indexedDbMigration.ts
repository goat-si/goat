import { legacyStorageKey } from "@goat/contracts/legacyT3Names";

const MIGRATION_STORE = "goat-migration";
const MIGRATION_KEY = "legacy-copy-complete";

function completed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Migration aborted.")),
    );
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

/** An aborted creation detects absence without leaving a new legacy database behind. */
function openLegacy(name: string) {
  return new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(name);
    let absent = false;
    request.addEventListener("upgradeneeded", () => {
      absent = true;
      request.transaction!.abort();
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => (absent ? resolve(null) : reject(request.error)));
    request.addEventListener("blocked", () => reject(new Error("Legacy storage is blocked.")));
  });
}

function open(name: string, upgrade: (database: IDBDatabase) => void, version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    request.addEventListener("upgradeneeded", () => {
      upgrade(request.result);
      if (!request.result.objectStoreNames.contains(MIGRATION_STORE)) {
        request.result.createObjectStore(MIGRATION_STORE);
      }
    });
    let blocked = false;
    request.addEventListener("success", () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.addEventListener("versionchange", () => request.result.close());
      resolve(request.result);
    });
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => {
      blocked = true;
      reject(new Error("Storage upgrade is blocked."));
    });
  });
}

async function snapshot(database: IDBDatabase) {
  const names = Array.from(database.objectStoreNames);
  if (names.length === 0) return [];
  const transaction = database.transaction(names, "readonly");
  const done = completed(transaction);
  const stores = await Promise.all(
    names.map(async (name) => {
      const store = transaction.objectStore(name);
      const keys = requestResult(store.getAllKeys());
      const values = requestResult(store.getAll()) as Promise<unknown[]>;
      return {
        name,
        keyPath: store.keyPath,
        autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames, (indexName) => {
          const index = store.index(indexName);
          return {
            name: indexName,
            keyPath: index.keyPath,
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        }),
        keys: await keys,
        values: await values,
      };
    }),
  );
  await done;
  return stores;
}

/** Copies records and the completion marker in one transaction; an abort retries next open. */
export function createMigratingDatabaseOpener(
  name: string,
  version: number,
  upgrade: (database: IDBDatabase) => void,
) {
  let migrated = false;
  let pending: Promise<IDBDatabase> | undefined;
  const openDatabase = async () => {
    let database = await open(name, upgrade);
    try {
      if (database.version < version || !database.objectStoreNames.contains(MIGRATION_STORE)) {
        const nextVersion = Math.max(version, database.version + 1);
        database.close();
        database = await open(name, upgrade, nextVersion);
      }
      if (migrated) return database;
      const marker = await requestResult(
        database.transaction(MIGRATION_STORE).objectStore(MIGRATION_STORE).get(MIGRATION_KEY),
      );
      if (typeof marker === "number" && marker >= version) {
        migrated = true;
        return database;
      }
      // Copying previously unknown stores can raise the physical IDB version beyond
      // the app's schema version. Keep the logical version in the completion marker.
      if (typeof marker === "number") {
        const nextVersion = database.version + 1;
        database.close();
        database = await open(name, upgrade, nextVersion);
      }
      const legacyName = legacyStorageKey(name);
      const legacy =
        typeof marker === "number" || legacyName === undefined
          ? null
          : await openLegacy(legacyName);
      let stores: Awaited<ReturnType<typeof snapshot>> = [];
      if (legacy) {
        try {
          stores = await snapshot(legacy);
        } finally {
          legacy.close();
        }
      }
      const missing = stores.filter((store) => !database.objectStoreNames.contains(store.name));
      if (missing.length > 0) {
        const nextVersion = database.version + 1;
        database.close();
        database = await open(
          name,
          (target) => {
            for (const source of missing) {
              const store = target.createObjectStore(source.name, {
                keyPath: source.keyPath,
                autoIncrement: source.autoIncrement,
              });
              for (const index of source.indexes)
                store.createIndex(index.name, index.keyPath, index);
            }
          },
          nextVersion,
        );
      }
      const names = Array.from(database.objectStoreNames);
      const transaction = database.transaction(names, "readwrite");
      const done = completed(transaction);
      // Serialize competing tabs' copies with their normal writes. Never replace GOAT data.
      const markerRequest = transaction.objectStore(MIGRATION_STORE).get(MIGRATION_KEY);
      markerRequest.addEventListener("success", () => {
        if (typeof markerRequest.result === "number" && markerRequest.result >= version) return;
        const dataNames = names.filter((store) => store !== MIGRATION_STORE);
        let remaining = dataNames.length;
        let empty = true;
        const copy = () => {
          try {
            if (empty) {
              for (const source of stores) {
                const target = transaction.objectStore(source.name);
                source.values.forEach((value, index) => {
                  if (target.keyPath === null) target.put(value, source.keys[index]);
                  else target.put(value);
                });
              }
            }
            transaction.objectStore(MIGRATION_STORE).put(version, MIGRATION_KEY);
          } catch {
            transaction.abort();
          }
        };
        if (remaining === 0) copy();
        for (const store of dataNames) {
          const count = transaction.objectStore(store).count();
          count.addEventListener("success", () => {
            empty &&= count.result === 0;
            if (--remaining === 0) copy();
          });
        }
      });
      await done;
      migrated = true;
      return database;
    } catch (cause) {
      database.close();
      throw cause;
    }
  };
  return () => {
    // Share only the migration attempt. Callers keep ownership of the returned connection.
    if (migrated) return open(name, upgrade);
    if (pending) return pending.then(() => open(name, upgrade));
    return (pending = openDatabase().finally(() => {
      pending = undefined;
    }));
  };
}
