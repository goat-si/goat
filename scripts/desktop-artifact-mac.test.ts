import * as NodeServices from "@effect/platform-node/NodeServices";
import { createPackageWithOptions } from "@electron/asar";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  BundleNotSelfContainedError,
  validateMacPackagedPayload,
} from "./build-desktop-artifact.ts";
import { MacPackagedAppMissingError } from "./desktop-artifact-mac.ts";

const makeMacPayloadFixture = Effect.fn("test.makeMacPayloadFixture")(function* (input: {
  readonly serverEntrySource?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-mac-payload-test-" });
  const sourceDir = path.join(tempDir, "app-source");
  const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
  yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
  yield* fs.writeFileString(serverEntryPath, input.serverEntrySource ?? "console.log('server');\n");

  const stageDistDir = path.join(tempDir, "dist");
  const resourcesDir = path.join(stageDistDir, "mac-arm64/GOAT.app/Contents/Resources");
  yield* fs.makeDirectory(resourcesDir, { recursive: true });
  yield* Effect.promise(() =>
    createPackageWithOptions(sourceDir, path.join(resourcesDir, "app.asar"), {}),
  );
  return { stageDistDir } as const;
});

it.layer(NodeServices.layer, { excludeTestServices: true })("macOS packaged payload", (it) => {
  it.effect("rejects a macOS app whose packaged server bundle cannot resolve", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeMacPayloadFixture({
          serverEntrySource: 'import "goat-deliberately-missing-package";\n',
        });
        const error = yield* validateMacPackagedPayload({
          stageDistDir: fixture.stageDistDir,
        }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
        assert.include(error.output, "goat-deliberately-missing-package");
      }),
    ),
  );

  it.effect("accepts a macOS app whose packaged server bundle resolves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeMacPayloadFixture({});
        yield* validateMacPackagedPayload({ stageDistDir: fixture.stageDistDir });
      }),
    ),
  );

  it.effect("rejects a macOS stage without a packaged app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageDistDir = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-mac-payload-test-",
        });
        const error = yield* validateMacPackagedPayload({ stageDistDir }).pipe(Effect.flip);

        assert.instanceOf(error, MacPackagedAppMissingError);
      }),
    ),
  );

  it.effect("rejects a macOS app without app.asar", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stageDistDir = yield* fs.makeTempDirectoryScoped({
          prefix: "goat-mac-payload-test-",
        });
        yield* fs.makeDirectory(`${stageDistDir}/mac-arm64/GOAT.app/Contents/Resources`, {
          recursive: true,
        });
        const error = yield* validateMacPackagedPayload({ stageDistDir }).pipe(Effect.flip);

        assert.instanceOf(error, BundleNotSelfContainedError);
      }),
    ),
  );
});
