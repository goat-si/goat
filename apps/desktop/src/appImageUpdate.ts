// @effect-diagnostics nodeBuiltinImport:off -- Used synchronously before Electron is ready.
import * as NodePath from "node:path";

export const APPIMAGE_PREVIOUS_PATH_ENV = "GOAT_APPIMAGE_PREVIOUS_PATH";

const APPIMAGE_NAME_VERSION = /\d+\.\d+\.\d+/u;

export function replacedVersionedAppImagePath(
  previousPath: string | undefined,
  appImagePath: string,
): string | null {
  // electron-updater moves a renamed AppImage beside the original.
  return previousPath !== undefined &&
    NodePath.posix.isAbsolute(previousPath) &&
    NodePath.posix.dirname(previousPath) === NodePath.posix.dirname(appImagePath) &&
    APPIMAGE_NAME_VERSION.test(NodePath.posix.basename(previousPath)) &&
    !APPIMAGE_NAME_VERSION.test(NodePath.posix.basename(appImagePath))
    ? previousPath
    : null;
}
