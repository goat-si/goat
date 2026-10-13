import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  copySafeStorageKey,
  makeWith,
  MARKER_FILE_NAME,
  type SafeStorageKeyStore,
} from "./DesktopSafeStorageKeyMigration.ts";

const memoryStore = (initial: Record<string, string>) => {
  const keys = new Map(Object.entries(initial));
  const store: SafeStorageKeyStore = {
    read: async (name) => keys.get(name) ?? null,
    write: async (name, key) => void keys.set(name, key),
  };
  return { keys, store };
};

it.effect("copies the first legacy key it finds and never replaces the new name's key", () =>
  Effect.promise(async () => {
    // Older builds keyed safeStorage to their initial package name; that one wins.
    const packaged = memoryStore({ GOAT: "package-key", "T3 Code Alpha": "stale-key" });
    assert.equal(
      await copySafeStorageKey(packaged.store, ["GOAT", "T3 Code Alpha"], "GOAT Alpha"),
      "copied",
    );
    assert.equal(packaged.keys.get("GOAT Alpha"), "package-key");
    // The legacy key stays for a rolled-back build.
    assert.equal(packaged.keys.get("GOAT"), "package-key");

    const fallback = memoryStore({ "T3 Code Alpha": "old-key" });
    assert.equal(
      await copySafeStorageKey(fallback.store, ["GOAT", "T3 Code Alpha"], "GOAT Alpha"),
      "copied",
    );
    assert.equal(fallback.keys.get("GOAT Alpha"), "old-key");

    const same = memoryStore({ GOAT: "key", "GOAT Alpha": "key" });
    assert.equal(await copySafeStorageKey(same.store, ["GOAT"], "GOAT Alpha"), "present");

    const diverged = memoryStore({ GOAT: "old-key", "GOAT Alpha": "fresh-key" });
    assert.equal(await copySafeStorageKey(diverged.store, ["GOAT"], "GOAT Alpha"), "conflict");
    assert.equal(diverged.keys.get("GOAT Alpha"), "fresh-key");

    const fresh = memoryStore({});
    assert.equal(
      await copySafeStorageKey(fresh.store, ["GOAT", "T3 Code Alpha"], "GOAT Alpha"),
      "no-legacy-key",
    );
    assert.isFalse(fresh.keys.has("GOAT Alpha"));
  }),
);

it.effect("marks success, retries after a store failure, and skips unkeyed platforms", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped();
    const input = { userDataPath, legacyRuntimeName: "T3 Code Alpha", runtimeName: "GOAT Alpha" };
    const markerPath = path.join(userDataPath, MARKER_FILE_NAME);

    let opened = 0;
    const failing = yield* makeWith(
      async () => {
        opened++;
        throw new Error("keyring locked");
      },
      "linux",
      "GOAT",
    );
    yield* failing.run(input);
    assert.equal(opened, 1);
    assert.isFalse(yield* fs.exists(markerPath));

    const unkeyed = yield* makeWith(async () => null, "win32", "GOAT");
    yield* unkeyed.run(input);
    assert.isFalse(yield* fs.exists(markerPath));

    const { keys, store } = memoryStore({ GOAT: "package-key" });
    const working = yield* makeWith(async () => store, "darwin", "GOAT");
    yield* working.run(input);
    assert.equal(keys.get("GOAT Alpha"), "package-key");
    assert.include(yield* fs.readFileString(markerPath), "copied");

    // Marked: the store is not opened again.
    yield* failing.run(input);
    assert.equal(opened, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
