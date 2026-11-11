// electron-builder file filters for the staged desktop app, kept apart from the build steps that
// apply them so build-desktop-artifact.ts stays inside its code budget.

type DesktopBuildArch = "arm64" | "x64" | "universal";

export const DESKTOP_FILE_EXCLUSIONS = [
  // Cursor walks from argv[1] to platform assets; helpers and native addons need real paths outside ASAR.
  "!**/node_modules/@cursor/sdk-*/**/*",
  "!apps/desktop/prod-resources/cursor-sdk",
  "!apps/desktop/prod-resources/cursor-sdk/**/*",
  // The resource monitor ships once at resources/resource-monitor, signed with the
  // app; a second copy inside app.asar would stay ad hoc signed.
  "!apps/desktop/prod-resources/resource-monitor",
  "!apps/desktop/prod-resources/resource-monitor/**/*",
  "!apps/desktop/prod-resources/screen-code/quickjs.wasm",
  // GOAT always passes the user's installed Claude executable to the SDK,
  // so the SDK's optional platform packages (each a ~200MB bundled executable)
  // are dead weight. The trailing dash keeps the SDK's own JS package.
  "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
  "!**/*.map",
  "!**/*.d.cts",
  "!apps/desktop/resources/browser-secret",
  "!apps/desktop/resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/browser-secret",
  "!apps/desktop/prod-resources/browser-secret/**/*",
  "!apps/desktop/prod-resources/windows-server",
  "!apps/desktop/prod-resources/windows-server/**/*",
  "!apps/desktop/prod-resources/ssh-runtime",
  "!apps/desktop/prod-resources/ssh-runtime/**/*",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz",
  "!apps/desktop/prod-resources/wsl-runtime.tar.gz.sha256",
  "!apps/desktop/prod-resources/LICENSE-T3CODE.txt",
  "!apps/desktop/gnome-extension",
  "!apps/desktop/gnome-extension/**/*",
  "!apps/desktop/prod-resources/cua-driver",
  "!apps/desktop/prod-resources/cua-driver/**/*",
  "!apps/desktop/resources/cua-driver",
  "!apps/desktop/resources/cua-driver/**/*",
  "!apps/desktop/prod-resources/computer-use-helper",
  "!apps/desktop/prod-resources/computer-use-helper/**/*",
  "!apps/desktop/resources/computer-use-helper",
  "!apps/desktop/resources/computer-use-helper/**/*",
  "!apps/desktop/resources/tray",
  "!apps/desktop/resources/tray/**/*",
] as const;
// Windows terminal helpers cannot run on macOS and slow signing and notarization.
const WINDOWS_PTY_FILE_EXCLUSIONS = [
  "!**/node_modules/node-pty/prebuilds/win32-*/**/*",
  "!**/node_modules/node-pty/third_party/conpty/**/*",
] as const;
export const MAC_FILE_EXCLUSIONS = [
  ...WINDOWS_PTY_FILE_EXCLUSIONS,
  // macOS uses helper stdio for both agents and readiness, never the SDK's native runtime.
  "!**/node_modules/@trycua/cua-driver/**/*",
  "!**/node_modules/@trycua/cua-driver-*/**/*",
] as const;
// Linux builds node-pty from source; its prebuilds target other platforms.
export const LINUX_FILE_EXCLUSIONS = [
  ...WINDOWS_PTY_FILE_EXCLUSIONS,
  "!**/node_modules/node-pty/prebuilds/darwin-*/**/*",
] as const;

// Universal apps need prebuilds for both Darwin architectures.
export function resolveMacFileExclusions(arch?: DesktopBuildArch) {
  if (arch === undefined || arch === "universal") {
    return [...MAC_FILE_EXCLUSIONS];
  }

  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  return [...MAC_FILE_EXCLUSIONS, `!**/node_modules/**/prebuilds/darwin-${unusedArch}/**/*`];
}

// Both halves of a universal app carry per-architecture natives byte-for-byte, and
// @electron/universal rejects that unless these paths name one darwin architecture for
// x64ArchFiles. Only such paths match, so modules rebuilt per slice still merge with lipo.
export const MAC_UNIVERSAL_SINGLE_ARCH_FILES =
  "**/node_modules/**/{*darwin-{arm64,x64}/**,*.darwin-{arm64,x64}.node}";
