import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  migrateRendererOrigin,
  RendererOriginMigrationError,
  type OriginPage,
  type OriginPageOpener,
} from "./DesktopRendererOriginMigration.ts";
import { ORIGIN_CHUNK_LIMITS } from "./rendererOriginStorage.ts";

const MiB = 1024 * 1024;

interface FakeOrigin {
  readonly indexedDB: IDBFactory;
  readonly localStorage: Map<string, string>;
}

const storageOf = (items: Map<string, string>) => ({
  get length() {
    return items.size;
  },
  key: (index: number) => [...items.keys()][index] ?? null,
  getItem: (key: string) => items.get(key) ?? null,
  setItem: (key: string, value: string) => void items.set(key, value),
});

/**
 * Each origin keeps its storage across page loads, and each page gets fresh globals, like a
 * detached WebContentsView. Every string that crosses main (scripts in, chunks out) is measured.
 */
const fakeBrowser = () => {
  const origins = new Map<string, FakeOrigin>();
  const originOf = (url: string) => {
    // `URL.origin` is "null" for custom schemes.
    const { protocol, host } = new URL(url);
    const origin = `${protocol}//${host}`;
    let state = origins.get(origin);
    if (state === undefined) {
      state = { indexedDB: new IDBFactory(), localStorage: new Map() };
      origins.set(origin, state);
    }
    return state;
  };
  const stats = { pages: 0, largestString: 0 };
  const openPage: OriginPageOpener = (_step, url) =>
    Effect.sync((): OriginPage => {
      stats.pages++;
      const state = originOf(url);
      const pageGlobals: Record<string, unknown> = {};
      const navigator = { storage: { estimate: async () => ({ usage: 0 }) } };
      return {
        run: (script) =>
          Effect.promise(async () => {
            stats.largestString = Math.max(stats.largestString, script.length);
            const evaluate = new Function(
              "globalThis",
              "indexedDB",
              "IDBKeyRange",
              "localStorage",
              "navigator",
              `return ${script}`,
            );
            const result: unknown = await evaluate(
              pageGlobals,
              state.indexedDB,
              IDBKeyRange,
              storageOf(state.localStorage),
              navigator,
            );
            if (typeof result === "object" && result !== null && "chunk" in result) {
              stats.largestString = Math.max(stats.largestString, String(result.chunk).length);
            }
            return result;
          }),
      };
    });
  return { origin: originOf, openPage, stats };
};

const request = <T>(pending: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    pending.addEventListener("success", () => resolve(pending.result));
    pending.addEventListener("error", () => reject(pending.error));
  });

interface SeedStore {
  readonly name: string;
  readonly keyPath: string | null;
  readonly index?: string;
  readonly records: ReadonlyArray<readonly [IDBValidKey, unknown]>;
}

const seed = async (factory: IDBFactory, name: string, stores: ReadonlyArray<SeedStore>) => {
  const open = factory.open(name, 1);
  open.onupgradeneeded = () => {
    for (const store of stores) {
      const created = open.result.createObjectStore(store.name, { keyPath: store.keyPath });
      if (store.index !== undefined) created.createIndex(store.index, store.index);
    }
  };
  const database = await request(open);
  for (const store of stores) {
    const transaction = database.transaction(store.name, "readwrite");
    const target = transaction.objectStore(store.name);
    for (const [key, value] of store.records) {
      if (store.keyPath === null) target.put(value, key);
      else target.put(value);
    }
    await new Promise((resolve) => (transaction.oncomplete = resolve));
  }
  database.close();
};

const readAll = async (factory: IDBFactory, name: string, storeName: string) => {
  const database = await request(factory.open(name));
  const store = database.transaction(storeName, "readonly").objectStore(storeName);
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  const indexes = Array.from(store.indexNames);
  database.close();
  return { entries: keys.map((key, i) => [key, values[i]] as const), indexes };
};

const tempPaths = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  return { markerPath: path.join(dir, "marker"), attemptPath: path.join(dir, "attempt") };
});

const LEGACY = "t3code://app";
const ORIGIN = "goat://app";

describe("migrateRendererOrigin", () => {
  it.effect("copies storage the new origin lacks, keeps what it has, then marks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* tempPaths;
      const browser = fakeBrowser();
      const legacy = browser.origin(LEGACY);
      const current = browser.origin(ORIGIN);
      legacy.localStorage.set("connections", "legacy").set("theme", "dark");
      current.localStorage.set("connections", "current").set("dismissed", "");
      const image = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
      yield* Effect.promise(async () => {
        await seed(legacy.indexedDB, "app", [
          {
            name: "threads",
            keyPath: "id",
            index: "projectId",
            records: [
              ["shared", { id: "shared", projectId: "p", value: "legacy" }],
              ["legacy-only", { id: "legacy-only", projectId: "p", image }],
            ],
          },
          { name: "keyvalue", keyPath: null, records: [["dpop", new Uint8Array([9])]] },
        ]);
        await seed(current.indexedDB, "app", [
          {
            name: "threads",
            keyPath: "id",
            records: [["shared", { id: "shared", projectId: "p", value: "current" }]],
          },
        ]);
      });

      const input = { ...paths, legacyOrigin: LEGACY, origin: ORIGIN, openPage: browser.openPage };
      assert.isTrue(yield* migrateRendererOrigin(input));

      assert.deepEqual(Object.fromEntries(current.localStorage), {
        connections: "current",
        dismissed: "",
        theme: "dark",
      });
      const threads = yield* Effect.promise(() => readAll(current.indexedDB, "app", "threads"));
      assert.deepEqual(
        threads.entries.map(([key, value]) => [key, (value as { value?: string }).value]),
        [
          ["legacy-only", undefined],
          ["shared", "current"],
        ],
      );
      const copied = threads.entries[0]![1] as { image: Blob };
      assert.deepEqual(
        [...new Uint8Array(yield* Effect.promise(() => copied.image.arrayBuffer()))],
        [1, 2, 3],
      );
      assert.equal(copied.image.type, "image/png");
      const keyvalue = yield* Effect.promise(() => readAll(current.indexedDB, "app", "keyvalue"));
      assert.deepEqual(keyvalue.entries, [["dpop", new Uint8Array([9])]]);
      assert.equal(yield* fs.readFileString(paths.markerPath), `${LEGACY} -> ${ORIGIN}\n`);
      assert.isFalse(yield* fs.exists(paths.attemptPath));

      // The marker ends it: later launches load no page.
      const pages = browser.stats.pages;
      assert.isFalse(yield* migrateRendererOrigin(input));
      assert.equal(browser.stats.pages, pages);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "copies 100+ MB of blobs in chunks bounded by the chunk budget, skipping oversized values",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* tempPaths;
        const browser = fakeBrowser();
        const legacy = browser.origin(LEGACY);
        const blobCount = 52;
        const blobBytes = 2 * MiB;
        yield* Effect.promise(() =>
          seed(legacy.indexedDB, "attachments", [
            {
              name: "blobs",
              keyPath: null,
              records: [
                ...Array.from(
                  { length: blobCount },
                  (_, i) =>
                    [
                      `blob-${String(i).padStart(3, "0")}`,
                      new Blob([new Uint8Array(blobBytes).fill(i)]),
                    ] as const,
                ),
                ["oversized", new Blob([new Uint8Array(ORIGIN_CHUNK_LIMITS.bytes + 1)])],
              ],
            },
            {
              name: "messages",
              keyPath: "id",
              records: Array.from({ length: 2500 }, (_, i) => [i, { id: i, text: "x".repeat(64) }]),
            },
          ]),
        );

        assert.isTrue(
          yield* migrateRendererOrigin({
            ...paths,
            legacyOrigin: LEGACY,
            origin: ORIGIN,
            openPage: browser.openPage,
          }),
        );

        const current = browser.origin(ORIGIN);
        const blobs = yield* Effect.promise(() =>
          readAll(current.indexedDB, "attachments", "blobs"),
        );
        assert.equal(blobs.entries.length, blobCount);
        assert.notInclude(
          blobs.entries.map(([key]) => key),
          "oversized",
        );
        const last = blobs.entries.at(-1)![1] as Blob;
        assert.equal(last.size, blobBytes);
        assert.equal(
          new Uint8Array(yield* Effect.promise(() => last.arrayBuffer()))[0],
          blobCount - 1,
        );
        const messages = yield* Effect.promise(() =>
          readAll(current.indexedDB, "attachments", "messages"),
        );
        assert.equal(messages.entries.length, 2500);
        assert.isTrue(yield* fs.exists(paths.markerPath));

        // Over 100 MB moved, yet no string main handled exceeded one base64-encoded chunk.
        assert.isAbove(blobCount * blobBytes, 100 * MiB);
        assert.isBelow(browser.stats.largestString, (ORIGIN_CHUNK_LIMITS.bytes * 4) / 3 + MiB);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("marks an attempt that never finished as aborted and loads no page", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* tempPaths;
      const browser = fakeBrowser();
      yield* fs.writeFileString(paths.attemptPath, `${LEGACY} -> ${ORIGIN}\n`);

      const input = { ...paths, legacyOrigin: LEGACY, origin: ORIGIN, openPage: browser.openPage };
      assert.isFalse(yield* migrateRendererOrigin(input));
      assert.equal(browser.stats.pages, 0);
      assert.equal(yield* fs.readFileString(paths.markerPath), `${LEGACY} -> ${ORIGIN} aborted\n`);
      assert.isFalse(yield* fs.exists(paths.attemptPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("holds the attempt marker while copying and leaves no marker after a failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* tempPaths;
      const browser = fakeBrowser();
      const attemptSeen: Array<boolean> = [];
      const openPage: OriginPageOpener = (step, url) =>
        Effect.gen(function* () {
          attemptSeen.push(yield* fs.exists(paths.attemptPath).pipe(Effect.orDie));
          if (step === "export") return yield* browser.openPage(step, url);
          return {
            run: () =>
              Effect.fail(new RendererOriginMigrationError({ step, url, cause: new Error("x") })),
          };
        });

      const error = yield* Effect.flip(
        migrateRendererOrigin({ ...paths, legacyOrigin: LEGACY, origin: ORIGIN, openPage }),
      );
      assert.instanceOf(error, RendererOriginMigrationError);
      assert.equal((error as RendererOriginMigrationError).step, "import");
      assert.deepEqual(attemptSeen, [true, true]);
      assert.isFalse(yield* fs.exists(paths.markerPath));
      // A failure main survives retries next launch rather than counting as a dead attempt.
      assert.isFalse(yield* fs.exists(paths.attemptPath));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
