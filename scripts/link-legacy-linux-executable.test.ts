import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import linkLegacyLinuxExecutable from "./link-legacy-linux-executable.ts";

it.layer(NodeServices.layer)("link-legacy-linux-executable", (it) => {
  it.effect("links the pre-rename Linux executable name to the packaged one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const appOutDir = yield* fs.makeTempDirectoryScoped();
      const context = { appOutDir, electronPlatformName: "linux" };
      yield* Effect.promise(() => linkLegacyLinuxExecutable(context));
      // electron-builder packs a second Linux target into the same directory.
      yield* Effect.promise(() => linkLegacyLinuxExecutable(context));
      assert.strictEqual(yield* fs.readLink(path.join(appOutDir, "t3code")), "goat-desktop");

      const macOutDir = yield* fs.makeTempDirectoryScoped();
      yield* Effect.promise(() =>
        linkLegacyLinuxExecutable({ appOutDir: macOutDir, electronPlatformName: "darwin" }),
      );
      assert.deepStrictEqual(yield* fs.readDirectory(macOutDir), []);
    }).pipe(Effect.scoped),
  );
});
