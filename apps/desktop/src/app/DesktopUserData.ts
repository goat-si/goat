import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    readonly appVersion: string;
  }) {
    const path = yield* Path.Path;
    const profile = input.isDevelopment
      ? "goat-desktop-dev"
      : isNightlyDesktopVersion(input.appVersion)
        ? "goat-desktop-nightly"
        : "goat-desktop";
    return path.join(input.appDataDirectory, profile);
  },
);
