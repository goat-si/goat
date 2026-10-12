import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMigratingDatabaseOpener } from "./indexedDbMigration";

const LEGACY_NAME = "t3code:connection-runtime"; // goat-rename: legacy
const NAME = "goat:connection-runtime";

function done(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}
function result<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function seed(name: string, key: unknown = "credential") {
  const request = indexedDB.open(name, 4);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("catalog");
    const thread = request.result.createObjectStore("thread", { keyPath: "id" });
    thread.createIndex("title", "title");
  };
  const database = await result(request);
  const transaction = database.transaction(["catalog", "thread"], "readwrite");
  transaction.objectStore("catalog").put(key, "document");
  transaction.objectStore("thread").put({ id: "thread-1", title: "Draft" });
  await done(transaction);
  database.close();
}
function opener() {
  return createMigratingDatabaseOpener(NAME, 4, (database) => {
    if (!database.objectStoreNames.contains("catalog")) database.createObjectStore("catalog");
  });
}
async function read(database: IDBDatabase, store = "catalog", key = "document") {
  return result(database.transaction(store).objectStore(store).get(key)) as Promise<unknown>;
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

describe("IndexedDB namespace copy", () => {
  it("copies all stores, keys and indexes and retains the legacy database", async () => {
    await seed(LEGACY_NAME);
    const database = await opener()();
    expect(await read(database)).toBe("credential");
    expect(await read(database, "thread", "thread-1")).toEqual({ id: "thread-1", title: "Draft" });
    expect(database.transaction("thread").objectStore("thread").indexNames.contains("title")).toBe(
      true,
    );
    database.close();
    const legacy = await result(indexedDB.open(LEGACY_NAME));
    expect(await read(legacy)).toBe("credential");
    legacy.close();
  });

  it("does not overwrite populated GOAT storage", async () => {
    await seed(LEGACY_NAME, "old");
    await seed(NAME, "new");
    const database = await opener()();
    expect(await read(database)).toBe("new");
    database.close();
  });

  it("never copies again after completion, even when the new stores are cleared", async () => {
    await seed(LEGACY_NAME);
    const first = await opener()();
    const transaction = first.transaction(["catalog", "thread"], "readwrite");
    transaction.objectStore("catalog").clear();
    transaction.objectStore("thread").clear();
    await done(transaction);
    first.close();
    const openSpy = vi.spyOn(indexedDB, "open");
    const second = await opener()();
    expect(await read(second)).toBeUndefined();
    expect(openSpy.mock.calls.some(([name]) => name === LEGACY_NAME)).toBe(false);
    second.close();
  });

  it("retries an interrupted transaction on the same opener and after reload", async () => {
    await seed(LEGACY_NAME);
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (
      this: IDBObjectStore,
      ...args
    ) {
      this.transaction.abort();
      return original.apply(this, args);
    });
    const openDatabase = opener();
    await expect(openDatabase()).rejects.toBeDefined();
    put.mockRestore();
    const retried = await openDatabase();
    expect(await read(retried)).toBe("credential");
    retried.close();
    const reloaded = await opener()();
    expect(await read(reloaded)).toBe("credential");
    reloaded.close();
  });

  it("applies future schema upgrades after copying an unknown legacy store", async () => {
    await seed(LEGACY_NAME);
    const first = await opener()();
    // The extra thread store makes the physical version higher than the logical schema.
    expect(first.version).toBeGreaterThan(4);
    const transaction = first.transaction(["catalog", "thread"], "readwrite");
    transaction.objectStore("catalog").clear();
    transaction.objectStore("thread").clear();
    await done(transaction);
    first.close();
    const openSpy = vi.spyOn(indexedDB, "open");
    const next = await createMigratingDatabaseOpener(NAME, 5, (database) => {
      if (!database.objectStoreNames.contains("future")) database.createObjectStore("future");
    })();
    expect(next.objectStoreNames.contains("future")).toBe(true);
    expect(await read(next)).toBeUndefined();
    expect(openSpy.mock.calls.some(([name]) => name === LEGACY_NAME)).toBe(false);
    next.close();
  });

  it("does not create a legacy database on a fresh install", async () => {
    const database = await opener()();
    expect(await read(database)).toBeUndefined();
    database.close();
    expect((await indexedDB.databases()).map(({ name }) => name)).toEqual([NAME]);
  });

  it("structured-clones non-extractable DPoP CryptoKeys", async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    await seed(LEGACY_NAME, keys.privateKey);
    const database = await opener()();
    const copied = (await read(database)) as CryptoKey;
    expect(copied.extractable).toBe(false);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      copied,
      new Uint8Array([1, 2, 3]),
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        signature,
        new Uint8Array([1, 2, 3]),
      ),
    ).toBe(true);
    database.close();
  });
});
