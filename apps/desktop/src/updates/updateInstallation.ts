import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export type DesktopUpdateInstallationReason = "translocated" | "read-only-volume" | "needs-admin";

export function classifyDesktopUpdateInstallation(input: {
  readonly platform: string;
  readonly appBundlePath: string;
  readonly bundleWritable: boolean;
  readonly parentWritable: boolean;
  readonly readOnlyVolume: boolean;
}): DesktopUpdateInstallationReason | null {
  if (input.platform !== "darwin") return null;
  if (input.appBundlePath.includes("/AppTranslocation/")) return "translocated";
  if (input.readOnlyVolume) return "read-only-volume";
  if (!input.bundleWritable || !input.parentWritable) return "needs-admin";
  return null;
}

const SERVER_UPDATE_NOTICE =
  "Servers this app connects to, including this Mac's SSH runtime, still update on their own.";

export function getDesktopUpdateInstallationMessage(
  reason: DesktopUpdateInstallationReason,
): string {
  switch (reason) {
    case "translocated":
      return `GOAT can't update itself while it runs from where it was downloaded. Move GOAT to Applications and reopen it. ${SERVER_UPDATE_NOTICE}`;
    case "read-only-volume":
      return `GOAT can't update itself from a read-only disk. Move GOAT to Applications and reopen it. ${SERVER_UPDATE_NOTICE}`;
    case "needs-admin":
      return `Your account can't write to GOAT or its folder, so installing updates needs an administrator. ${SERVER_UPDATE_NOTICE}`;
  }
}

export const inspectDesktopUpdateInstallation = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  if (environment.platform !== "darwin" || !environment.isPackaged) return null;
  // Electron's app path points inside the bundle (usually app.asar), not at the bundle.
  const bundlePath = environment.appPath.match(/^(.*?\.app)(?:\/|$)/)?.[1];
  if (!bundlePath) return null;
  const writability = (path: string) =>
    fileSystem.access(path, { writable: true }).pipe(
      Effect.match({
        onSuccess: () => "writable" as const,
        // access(2) reports EROFS only for a read-only filesystem, such as a mounted disk
        // image; a plain permission failure on a writable disk still allows an admin install.
        onFailure: (error) =>
          (error.reason as { cause?: { code?: unknown } }).cause?.code === "EROFS"
            ? ("read-only" as const)
            : ("denied" as const),
      }),
    );
  const [bundle, parent] = yield* Effect.all([
    writability(bundlePath),
    writability(environment.path.dirname(bundlePath)),
  ]);
  return classifyDesktopUpdateInstallation({
    platform: environment.platform,
    appBundlePath: bundlePath,
    bundleWritable: bundle === "writable",
    parentWritable: parent === "writable",
    readOnlyVolume: bundle === "read-only" || parent === "read-only",
  });
});
