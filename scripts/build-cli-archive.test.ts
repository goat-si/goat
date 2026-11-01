import * as NodeServices from "@effect/platform-node/NodeServices";
import { LEGACY_RESOURCE_MONITOR_BINARY_NAME } from "@goat/contracts/legacyT3Names";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  ownRuntimeManifest,
  decodeRuntimeManifest,
  RUNTIME_MANIFEST_ARCHIVE_ENTRY,
} from "@goat/shared/runtimeManifest";
import { stageCliRuntimeManifest, stageCliResourceMonitor } from "./build-cli-archive.ts";

it.effect.each(["", ".exe"])(
  "stages current and legacy cached CLI monitors with only the new name%s",
  (suffix) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-monitor-" });
      const source = path.join(root, "source");
      const current = `goat-resource-monitor${suffix}`;
      const legacy = `${LEGACY_RESOURCE_MONITOR_BINARY_NAME}${suffix}`;
      for (const mode of ["both", "legacy-only"]) {
        const sourcePlatform = path.join(source, mode);
        yield* fs.makeDirectory(sourcePlatform, { recursive: true });
        yield* fs.writeFileString(path.join(sourcePlatform, legacy), "legacy");
        yield* fs.chmod(path.join(sourcePlatform, legacy), 0o755);
        if (mode === "both")
          yield* fs.writeFileString(path.join(sourcePlatform, current), "current");
      }
      const destination = path.join(root, "destination");
      yield* stageCliResourceMonitor(source, destination);
      for (const mode of ["both", "legacy-only"]) {
        const staged = path.join(destination, mode);
        assert.deepEqual(yield* fs.readDirectory(staged), [current]);
        assert.equal(
          yield* fs.readFileString(path.join(staged, current)),
          mode === "both" ? "current" : "legacy",
        );
        assert.isTrue(yield* fs.exists(path.join(source, mode, legacy)));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["darwin-arm64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64"])(
  "stages a runtime manifest beside the executable for %s",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-cli-manifest-" });
      const contentDir = path.join(root, `goat-1.2.3-${platform}`);
      yield* fs.makeDirectory(contentDir);
      yield* fs.writeFileString(
        path.join(contentDir, platform.startsWith("win32") ? "goat.exe" : "goat"),
        "binary",
      );
      const input = { version: "1.2.3", commit: "abc123", commitTime: 123456 };
      yield* stageCliRuntimeManifest(contentDir, input);
      const text = yield* fs.readFileString(path.join(contentDir, RUNTIME_MANIFEST_ARCHIVE_ENTRY));
      assert.deepEqual(decodeRuntimeManifest(text), ownRuntimeManifest(input));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
