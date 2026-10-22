import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "@goat/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@goat/contracts";
import { ConnectionCatalogDocument, Persistence } from "@goat/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

vi.mock("../lib/indexedDbMigration", () => ({
  createMigratingDatabaseOpener: (name: string) => () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    }),
}));

import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect("refuses a future catalog without quarantining or overwriting it", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({ ...emptyCatalog, schemaVersion: 99 });
      const writes: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(raw),
        write: (value) =>
          Effect.sync(() => {
            writes.push(value);
          }),
        quarantine: (value) =>
          Effect.sync(() => {
            writes.push(value);
          }),
      });
      expect(yield* Effect.flip(store.read)).toMatchObject({ _tag: "ConnectionTransientError" });
      expect(yield* Effect.flip(store.update((document) => document))).toMatchObject({
        _tag: "ConnectionTransientError",
      });
      expect(writes).toEqual([]);
    }),
  );

  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect(
    "preserves sequential additions and deletions from desktop channels with stale caches",
    () =>
      Effect.gen(function* () {
        let disk: string | null = encodeCatalog(emptyCatalog);
        const setConnectionCatalog = vi.fn(async (raw: string, expected: string | null) => {
          if (disk !== expected) return "conflict" as const;
          disk = raw;
          return true;
        });
        vi.stubGlobal("window", {
          desktopBridge: {
            getConnectionCatalog: async () => disk,
            setConnectionCatalog,
          },
        });
        const backend = () => ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));
        const first = yield* ConnectionStorage.makeCatalogStore(backend());
        const second = yield* ConnectionStorage.makeCatalogStore(backend());
        yield* first.read;
        yield* second.read;
        const a = new RelayConnectionTarget({ environmentId: EnvironmentId.make("A"), label: "A" });
        const b = new RelayConnectionTarget({ environmentId: EnvironmentId.make("B"), label: "B" });
        yield* first.update((catalog) => ({ ...catalog, targets: [...catalog.targets, a] }));
        yield* second.update((catalog) => ({ ...catalog, targets: [...catalog.targets, b] }));
        expect(decodeCatalog(disk!).targets).toEqual([a, b]);
        yield* first.update((catalog) => ({
          ...catalog,
          targets: catalog.targets.filter((t) => t.environmentId !== a.environmentId),
        }));
        yield* second.update((catalog) => ({
          ...catalog,
          disabledEnvironmentIds: [b.environmentId],
        }));
        expect(decodeCatalog(disk!).targets).toEqual([b]);
        expect(decodeCatalog(disk!).disabledEnvironmentIds).toEqual([b.environmentId]);
      }),
  );

  it.effect(
    "reloads and reapplies after a desktop CAS conflict and bounds repeated conflicts",
    () =>
      Effect.gen(function* () {
        const a = new RelayConnectionTarget({ environmentId: EnvironmentId.make("A"), label: "A" });
        const b = new RelayConnectionTarget({ environmentId: EnvironmentId.make("B"), label: "B" });
        let disk = encodeCatalog(emptyCatalog);
        let conflict = true;
        let alwaysConflict = false;
        const setConnectionCatalog = vi.fn(async (raw: string, expected: string | null) => {
          if (conflict || alwaysConflict) {
            conflict = false;
            disk = encodeCatalog({ ...emptyCatalog, targets: [a] });
            return "conflict" as const;
          }
          if (disk !== expected) return "conflict" as const;
          disk = raw;
          return true;
        });
        vi.stubGlobal("window", {
          desktopBridge: {
            getConnectionCatalog: async () => disk,
            setConnectionCatalog,
          },
        });
        const store = yield* ConnectionStorage.makeCatalogStore(
          ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase)),
        );
        const addB = (catalog: typeof ConnectionCatalogDocument.Type) => ({
          ...catalog,
          targets: [...catalog.targets, b],
        });
        yield* store.update(addB);
        expect(decodeCatalog(disk).targets).toEqual([a, b]);
        expect(setConnectionCatalog).toHaveBeenCalledTimes(2);
        alwaysConflict = true;
        const error = yield* store.update(addB).pipe(Effect.flip);
        expect(error.message).toContain("kept changing");
        expect(setConnectionCatalog).toHaveBeenCalledTimes(7);
        alwaysConflict = false;
        yield* store.update(addB);
        expect(decodeCatalog(disk).targets).toEqual([a, b]);
      }),
  );

  it.effect("replaces a corrupt desktop catalog on read and on a save without a read", () =>
    Effect.gen(function* () {
      let disk: string | null = "{not-json";
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: async () => disk,
          setConnectionCatalog: async (raw: string, expected: string | null) => {
            if (disk !== expected) return "conflict" as const;
            disk = raw;
            return true;
          },
        },
      });
      const backend = () => ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));
      const reader = yield* ConnectionStorage.makeCatalogStore(backend());
      expect(yield* reader.read).toEqual(emptyCatalog);
      expect(decodeCatalog(disk!)).toEqual(emptyCatalog);

      disk = "{not-json";
      const a = new RelayConnectionTarget({ environmentId: EnvironmentId.make("A"), label: "A" });
      const writer = yield* ConnectionStorage.makeCatalogStore(backend());
      yield* writer.update((catalog) => ({ ...catalog, targets: [...catalog.targets, a] }));
      expect(decodeCatalog(disk!).targets).toEqual([a]);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}", null);
    }),
  );

  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const legacyKey = "t3code:github-routing:first"; // goat-rename: legacy
      const legacyPermission = localStorage.getItem("goat:github-routing:first")!;
      localStorage.setItem(legacyKey, legacyPermission);
      localStorage.removeItem("goat:github-routing:first");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      expect(oldPermissions).toHaveLength(1);
      expect(localStorage.getItem("goat:github-routing:first")).toBe(legacyPermission);
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      expect(localStorage.getItem(legacyKey)).toBe(legacyPermission);
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});

describe("IndexedDB shell capture metadata", () => {
  it.effect("round-trips capture time with its sequence", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const values = new Map<IDBValidKey, unknown>();
      const database = Object.assign(new EventTarget(), {
        transaction: () => {
          const transaction = Object.assign(new EventTarget(), {
            error: null,
            objectStore: () => ({
              get: (key: IDBValidKey) => {
                const request = Object.assign(new EventTarget(), {
                  result: values.get(key),
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
              put: (value: unknown, key: IDBValidKey) => {
                values.set(key, value);
                queueMicrotask(() => transaction.dispatchEvent(new Event("complete")));
              },
            }),
          });
          return transaction;
        },
        close: vi.fn(),
      });
      vi.stubGlobal("indexedDB", {
        open: () => {
          const request = Object.assign(new EventTarget(), { result: database, error: null });
          queueMicrotask(() => request.dispatchEvent(new Event("success")));
          return request;
        },
      });
      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const id = EnvironmentId.make("node");
        const meta = { snapshotSequence: 7, capturedAt: "2026-10-19T12:00:00.000Z" };
        expect(yield* cache.loadShellMeta(id)).toEqual(Option.none());
        yield* cache.saveShellMeta(id, meta);
        expect(yield* cache.loadShellMeta(id)).toEqual(Option.some(meta));
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});
