export function resolveDesktopUpdateChannel(version: string): "latest" | "nightly" {
  return /-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest";
}
