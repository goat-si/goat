import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import gnomeCaptureBundle from "../apps/desktop/gnome-extension/bundle.json" with { type: "json" };

export const LINUX_CAPTURE_EXTRA_RESOURCES = [
  {
    from: "apps/desktop/prod-resources/hyprland-capture",
    to: "hyprland-capture",
  },
  {
    from: "apps/desktop/prod-resources/kde-capture",
    to: "kde-capture",
  },
  {
    from: "apps/desktop/gnome-extension",
    to: "gnome-extension",
    filter: gnomeCaptureBundle.files,
  },
] as const;
export const LINUX_BROWSER_SECRET_EXTRA_RESOURCES = [
  { from: "apps/desktop/prod-resources/browser-secret", to: "browser-secret" },
] as const;

export class LinuxPackagedAppMissingError extends Schema.TaggedError<LinuxPackagedAppMissingError>()(
  "LinuxPackagedAppMissingError",
  { stageDistDir: Schema.String },
) {
  override get message(): string {
    return `Expected electron-builder to leave resources/app.asar under ${this.stageDistDir}/linux*-unpacked.`;
  }
}

export const makeLinuxPackagedPayloadValidator = (
  verifyPackagedBundleIsSelfContained: typeof import("./build-desktop-artifact.ts").verifyPackagedBundleIsSelfContained,
) =>
  Effect.fn("desktopArtifact.validateLinuxPackagedPayload")(function* (input: {
    readonly stageDistDir: string;
    readonly verbose?: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const asarPaths = (yield* fs.readDirectory(input.stageDistDir))
      .filter((entry) => entry.startsWith("linux") && entry.endsWith("-unpacked"))
      .map((entry) => path.join(input.stageDistDir, entry, "resources/app.asar"));
    if (asarPaths.length === 0) {
      return yield* new LinuxPackagedAppMissingError({ stageDistDir: input.stageDistDir });
    }
    for (const asarPath of asarPaths) {
      yield* verifyPackagedBundleIsSelfContained({ asarPath, verbose: input.verbose ?? false });
    }
    yield* Effect.log(
      `[desktop-artifact] Validated Linux payload (${String(asarPaths.length)} app bundle(s)).`,
    );
  });
