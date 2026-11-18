import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { clearStaleGpuCaches, resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "linux", "win32"] as const)(
  "isolates GOAT channels without importing upstream profiles on %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-profile-" });
      for (const name of ["t3code-v2", "t3code", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        yield* fs.makeDirectory(path.join(root, name, "IndexedDB"), { recursive: true });
        yield* fs.writeFileString(path.join(root, name, "Local State"), "upstream keys");
        yield* fs.writeFileString(path.join(root, name, "IndexedDB", "LOCK"), "upstream database");
      }
      for (const [version, development, profile] of [
        ["1.2.3", false, "goat-desktop"],
        ["1.2.3-nightly.20261011.1", false, "goat-desktop-nightly"],
        ["1.2.3", true, "goat-desktop-dev"],
      ] as const) {
        const actual = yield* resolveUserDataPath({
          appDataDirectory: root,
          isDevelopment: development,
          platform,
          appVersion: version,
        });
        assert.equal(actual, path.join(root, profile));
        assert.isFalse(yield* fs.exists(path.join(actual, "Local State")));
        yield* fs.makeDirectory(actual, { recursive: true });
        yield* fs.writeFileString(path.join(actual, "Local State"), profile);
        assert.equal(
          yield* resolveUserDataPath({
            appDataDirectory: root,
            isDevelopment: development,
            platform,
            appVersion: version,
          }),
          actual,
        );
        assert.equal(yield* fs.readFileString(path.join(actual, "Local State")), profile);
      }
      for (const name of ["t3code-v2", "t3code", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
        assert.equal(
          yield* fs.readFileString(path.join(root, name, "Local State")),
          "upstream keys",
        );
        assert.equal(
          yield* fs.readFileString(path.join(root, name, "IndexedDB", "LOCK")),
          "upstream database",
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gpuCacheDirectories = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

it.effect.each([
  { profile: "written by Electron 44.10.0", marker: "44.10.0" },
  { profile: "with no recorded Electron version", marker: undefined },
])("clears GPU caches $profile once when Electron 44.10.1 starts", ({ marker }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped({ prefix: "goat-gpu-cache-" });
    for (const name of gpuCacheDirectories) {
      yield* fs.makeDirectory(path.join(userDataPath, name), { recursive: true });
      yield* fs.writeFileString(path.join(userDataPath, name, "data_0"), "44.10.0 shaders");
    }
    yield* fs.makeDirectory(path.join(userDataPath, "Local Storage"), { recursive: true });
    yield* fs.writeFileString(path.join(userDataPath, "Local Storage", "LOCK"), "profile");
    yield* fs.writeFileString(path.join(userDataPath, "Local State"), "profile");
    if (marker !== undefined) {
      yield* fs.writeFileString(path.join(userDataPath, "gpu-cache-electron-version"), marker);
    }

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    const survivingCaches: Array<string> = [];
    for (const name of gpuCacheDirectories) {
      if (yield* fs.exists(path.join(userDataPath, name))) survivingCaches.push(name);
    }
    assert.deepStrictEqual(survivingCaches, []);
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "Local Storage", "LOCK")),
      "profile",
    );
    assert.equal(yield* fs.readFileString(path.join(userDataPath, "Local State")), "profile");

    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps GPU caches built on the first launch of a fresh install", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appData = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-fresh-" });
    const userDataPath = path.join(appData, "t3code-v2");

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries on the next launch when a GPU cache cannot be removed", () =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      remove: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: path,
          }),
        ),
      writeFileString: (path) =>
        Effect.sync(() => {
          writes.push(path);
        }),
    });

    yield* clearStaleGpuCaches({ userDataPath: "/profile", electronVersion: "44.10.1" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    assert.deepStrictEqual(writes, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
