import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveUserDataPath } from "./DesktopUserData.ts";

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
