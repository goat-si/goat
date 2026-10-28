import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class MacPackagedAppMissingError extends Schema.TaggedError<MacPackagedAppMissingError>()(
  "MacPackagedAppMissingError",
  { stageDistDir: Schema.String },
) {
  override get message(): string {
    return `Expected electron-builder to leave a packaged .app with Contents/Resources/app.asar under ${this.stageDistDir}/mac*.`;
  }
}

export const makeMacPackagedPayloadValidator = (
  verifyPackagedBundleIsSelfContained: typeof import("./build-desktop-artifact.ts").verifyPackagedBundleIsSelfContained,
) =>
  Effect.fn("desktopArtifact.validateMacPackagedPayload")(function* (input: {
    readonly stageDistDir: string;
    readonly verbose?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const asarPaths: string[] = [];
    for (const entry of yield* fs.readDirectory(input.stageDistDir)) {
      if (!entry.startsWith("mac")) continue;
      const outputDir = path.join(input.stageDistDir, entry);
      const apps = yield* fs.readDirectory(outputDir).pipe(Effect.orElseSucceed(() => []));
      for (const app of apps) {
        if (app.endsWith(".app")) {
          asarPaths.push(path.join(outputDir, app, "Contents/Resources/app.asar"));
        }
      }
    }
    if (asarPaths.length === 0) {
      return yield* new MacPackagedAppMissingError({ stageDistDir: input.stageDistDir });
    }
    for (const asarPath of asarPaths) {
      yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: input.verbose ?? false });
    }
    yield* Effect.log(
      `[desktop-artifact] Validated macOS payload (${String(asarPaths.length)} app bundle(s)).`,
    );
  });
