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

it.effect("copies the legacy key once and never replaces a key the new name has", () =>
  Effect.promise(async () => {
    const legacyOnly = memoryStore({ "T3 Code Alpha": "old-key" });
    assert.equal(
      await copySafeStorageKey(legacyOnly.store, "T3 Code Alpha", "GOAT Alpha"),
      "copied",
    );
    assert.equal(legacyOnly.keys.get("GOAT Alpha"), "old-key");
    // The legacy key stays for a rolled-back build.
    assert.equal(legacyOnly.keys.get("T3 Code Alpha"), "old-key");

    const both = memoryStore({ "T3 Code Alpha": "old-key", "GOAT Alpha": "new-key" });
    assert.equal(await copySafeStorageKey(both.store, "T3 Code Alpha", "GOAT Alpha"), "present");
    assert.equal(both.keys.get("GOAT Alpha"), "new-key");

    const fresh = memoryStore({});
    assert.equal(
      await copySafeStorageKey(fresh.store, "T3 Code Alpha", "GOAT Alpha"),
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
    const failing = yield* makeWith(async () => {
      opened++;
      throw new Error("keyring locked");
    }, "linux");
    yield* failing.run(input);
    assert.equal(opened, 1);
    assert.isFalse(yield* fs.exists(markerPath));

    const unkeyed = yield* makeWith(async () => null, "win32");
    yield* unkeyed.run(input);
    assert.isFalse(yield* fs.exists(markerPath));

    const { keys, store } = memoryStore({ "T3 Code Alpha": "old-key" });
    const working = yield* makeWith(async () => store, "darwin");
    yield* working.run(input);
    assert.equal(keys.get("GOAT Alpha"), "old-key");
    assert.include(yield* fs.readFileString(markerPath), "copied");

    // Marked: the store is not opened again.
    yield* failing.run(input);
    assert.equal(opened, 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
