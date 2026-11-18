export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}

/** Published AppImages without a version, so electron-updater replaces them in place. False reverts O25. */
export const VERSION_FREE_APPIMAGES = true;
