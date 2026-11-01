import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("resolves GOAT profiles synchronously and leaves old Windows keys untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-pre-ready-" });
      const old = path.join(root, "T3 Code (Alpha)", "Local State");
      yield* fs.makeDirectory(path.dirname(old), { recursive: true });
      yield* fs.writeFileString(old, "upstream keys");
      const synchronous = yield* Effect.context<Path.Path>();
      // oxlint-disable-next-line goat/no-manual-effect-runtime-in-tests -- Proves the pre-ready path resolver cannot yield before Electron is ready.
      const actual = Effect.runSync(
        DesktopUserData.resolveUserDataPath({
          appDataDirectory: root,
          isDevelopment: false,
          platform: "win32",
          appVersion: "1.2.3",
        }).pipe(Effect.provide(synchronous), Effect.provide(DesktopPreReadyFileSystem.layer)),
      );
      assert.equal(actual, path.join(root, "goat-desktop"));
      assert.isFalse(yield* fs.exists(path.join(actual, "Local State")));
      assert.equal(
        // oxlint-disable-next-line goat/no-manual-effect-runtime-in-tests -- Proves the pre-ready filesystem adapter reads synchronously.
        Effect.runSync(DesktopPreReadyFileSystem.make.readFileString(old)),
        "upstream keys",
      );
      assert.equal(yield* fs.readFileString(old), "upstream keys");
    }),
  );
});
