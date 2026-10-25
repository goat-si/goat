import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

const { keychainEntries } = vi.hoisted(() => ({ keychainEntries: [] as string[] }));
vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    constructor(service: string) {
      keychainEntries.push(service);
    }
    getPassword() {
      return null;
    }
    setPassword() {}
  },
}));

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  copySafeStorageKey,
  DesktopSafeStorageKeyMigration,
  layer,
  macKeychainItem,
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
    assert.equal(fallback.keys.get("T3 Code Alpha"), "old-key");

    const same = memoryStore({ GOAT: "key", "GOAT Alpha": "key" });
    assert.equal(await copySafeStorageKey(same.store, ["GOAT"], "GOAT Alpha"), "present");

    const diverged = memoryStore({ GOAT: "old-key", "GOAT Alpha": "fresh-key" });
    assert.equal(await copySafeStorageKey(diverged.store, ["GOAT"], "GOAT Alpha"), "conflict");
    assert.equal(diverged.keys.get("GOAT Alpha"), "fresh-key");
    assert.equal(diverged.keys.get("GOAT"), "old-key");

    const fresh = memoryStore({});
    assert.equal(
      await copySafeStorageKey(fresh.store, ["GOAT", "T3 Code Alpha"], "GOAT Alpha"),
      "no-legacy-key",
    );
    assert.isFalse(fresh.keys.has("GOAT Alpha"));
  }),
);

it.effect.each<{ result: string; initial: Record<string, string> }>([
  { result: "present", initial: { "GOAT Alpha": "current-key" } },
  { result: "no-legacy-key", initial: {} },
  { result: "conflict", initial: { GOAT: "legacy-key", "GOAT Alpha": "current-key" } },
])("marks $result without changing keys and skips the next launch", ({ result, initial }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped();
    const { keys, store } = memoryStore(initial);
    const before = [...keys];
    let opened = 0;
    const migration = yield* makeWith(
      async () => {
        opened++;
        return store;
      },
      "darwin",
      "GOAT",
    );
    const input = { userDataPath, legacyRuntimeName: "T3 Code Alpha", runtimeName: "GOAT Alpha" };

    yield* migration.run(input);
    assert.include(yield* fs.readFileString(path.join(userDataPath, MARKER_FILE_NAME)), result);
    yield* migration.run(input);
    assert.equal(opened, 1);
    assert.deepEqual([...keys], before);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("copies a key left under the old source productName once the package is named GOAT", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped();
    const { keys, store } = memoryStore({ "T3 Code (Alpha)": "dev-key" });
    const migration = yield* makeWith(async () => store, "darwin", "GOAT");

    yield* migration.run({
      userDataPath,
      legacyRuntimeName: "T3 Code Dev",
      runtimeName: "GOAT Dev",
    });

    assert.equal(keys.get("GOAT Dev"), "dev-key");
    assert.equal(keys.get("T3 Code (Alpha)"), "dev-key");
    assert.include(yield* fs.readFileString(path.join(userDataPath, MARKER_FILE_NAME)), "copied");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

it("addresses the Keychain item Electron itself reads and writes", () => {
  // Items found on a real macOS install: pre-#127 GOAT created "t3code Safe Storage" / "t3code Key"
  // and Electron 44 created "GOAT Alpha Safe Storage" / "GOAT Alpha Key". A lookup under any other
  // account finds nothing, so the copy reported no-legacy-key and Electron started a fresh key.
  assert.deepEqual(macKeychainItem("t3code"), {
    service: "t3code Safe Storage",
    account: "t3code Key",
  });
  assert.deepEqual(macKeychainItem("GOAT Alpha"), {
    service: "GOAT Alpha Safe Storage",
    account: "GOAT Alpha Key",
  });
});
const desktopEnvironmentLayer = (input: {
  readonly homeDirectory: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: input.homeDirectory,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.22",
    appPath: "/repo/apps/desktop",
    isPackaged: false,
    resourcesPath: "/repo/apps/desktop/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(input.env)),
    ),
  );

it.effect("never reads the Keychain at startup for an opted-in dev run in an isolated home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempRoot = yield* fs.makeTempDirectoryScoped();
    const homeDirectory = path.join(tempRoot, "home");
    const run = (env: Readonly<Record<string, string | undefined>>) =>
      Effect.gen(function* () {
        const userDataPath = yield* fs.makeTempDirectoryScoped();
        keychainEntries.length = 0;
        yield* Effect.gen(function* () {
          const migration = yield* DesktopSafeStorageKeyMigration;
          yield* migration.run({
            userDataPath,
            legacyRuntimeName: "T3 Code Dev",
            runtimeName: "GOAT Dev",
          });
        }).pipe(
          Effect.provide(
            layer({ initialRuntimeName: "Electron" }).pipe(
              Layer.provide(desktopEnvironmentLayer({ homeDirectory, env })),
            ),
          ),
        );
        return {
          keychainEntries: [...keychainEntries],
          marked: yield* fs.exists(path.join(userDataPath, MARKER_FILE_NAME)),
        };
      });
    const isolated = {
      GOAT_HOME: path.join(tempRoot, "isolated-goat"),
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    };

    // #1298: each read of another bundle's Keychain item prompts an unsigned dev build.
    const bypassed = yield* run({ ...isolated, GOAT_DEV_INSECURE_SECRET_STORAGE: "1" });
    assert.deepEqual(bypassed.keychainEntries, []);
    // Unmarked, so the migration still runs once the opt-in is removed.
    assert.isFalse(bypassed.marked);

    const withoutOptIn = yield* run(isolated);
    assert.include(withoutOptIn.keychainEntries, "GOAT Dev Safe Storage");

    const defaultHome = yield* run({
      GOAT_HOME: path.join(homeDirectory, ".goat"),
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
      GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
    });
    assert.include(defaultHome.keychainEntries, "GOAT Dev Safe Storage");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
