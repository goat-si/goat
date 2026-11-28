import { it, expect } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";
import { layerTest } from "./AssetAccess.testkit.ts";

// Windows' native realpath fails with ENOENT on some removable drives (an exFAT USB
// drive) whose files Node can still stat, open and resolve with the JS realpath.
it.effect("previews a readable media file when the native realpath cannot resolve it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-no-native-realpath-" }),
    );
    const filePath = path.join(directory, "preview-test.jpg");
    yield* fs.writeFileString(filePath, "media");
    const nativeRealPathFails = FileSystem.FileSystem.of({
      ...fs,
      realPath: (requestedPath) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "FileSystem",
            method: "realPath",
            pathOrDescriptor: requestedPath,
          }),
        ),
    });
    const result = yield* issueAssetUrl({
      resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
    }).pipe(Effect.provideService(FileSystem.FileSystem, nativeRealPathFails));
    const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separator = suffix.indexOf("/");
    expect(
      yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
        Effect.provideService(FileSystem.FileSystem, nativeRealPathFails),
      ),
    ).toMatchObject({ kind: "file", path: filePath });
  }).pipe(Effect.provide(layerTest)),
);
