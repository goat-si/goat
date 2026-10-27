// GOAT's Cua Driver fork (goat-si/cua-driver): unsigned release archives with build-provenance
// attestations; GOAT signs the driver inside its helper. The daemon reports this version, and
// hosts compare it exactly. Bump it with the archive pins and third-party-licenses.config.json.
export const CUA_DRIVER_VERSION = "0.38.0-goat.2";

/** The macOS helper app that owns computer use's TCC identity (Contents/Helpers in GOAT.app). */
export const COMPUTER_USE_HELPER_NAME = "GOAT Computer Use";

/** Each desktop channel's app id, which a dev launcher overrides with a per-checkout one. */
export const DESKTOP_CHANNEL_APP_IDS = {
  stable: "si.goat.desktop",
  nightly: "si.goat.desktop.nightly",
  dev: "si.goat.desktop.dev",
} as const;
export type DesktopChannel = keyof typeof DESKTOP_CHANNEL_APP_IDS;

export const computerUseHelperBundleId = (desktopAppId: string) => `${desktopAppId}.computer-use`;

/**
 * One helper per desktop channel, so stable, nightly and dev each keep their own grants. It never
 * follows a dev checkout's own app id: macOS would keep one grant per checkout (#1275).
 */
export const computerUseHelperBundleIdForChannel = (channel: DesktopChannel) =>
  computerUseHelperBundleId(DESKTOP_CHANNEL_APP_IDS[channel]);

const archives = {
  "darwin-universal": {
    archiveName: "cua-driver-rs-0.38.0-goat.2-darwin-universal-binary.tar.gz",
    bytes: 53_711_725,
    sha256: "49483b0cb51ef10be46953b72f9d0a3bb8360a3b3817379fd7f9840229693f19",
  },
  "linux-x64": {
    archiveName: "cua-driver-rs-0.38.0-goat.2-linux-x86_64-binary.tar.gz",
    bytes: 37_089_692,
    sha256: "a569963f59e254fc85d258944ce9428ad0c26562c2bc56649e72ce75fbcc39d2",
  },
  "linux-arm64": {
    archiveName: "cua-driver-rs-0.38.0-goat.2-linux-arm64-binary.tar.gz",
    bytes: 36_742_336,
    sha256: "17f01bfa43d48fc88baaa2752eba38613632aa26b2af7e09d38cf8bda405125e",
  },
  "win32-x64": {
    archiveName: "cua-driver-rs-0.38.0-goat.2-windows-x86_64-binary.zip",
    bytes: 35_470_826,
    sha256: "8529f986ad9d4eb18dcef2f5cd69d2037f550e63dc3dbae360eb454d8883a17d",
  },
  "win32-arm64": {
    archiveName: "cua-driver-rs-0.38.0-goat.2-windows-arm64-binary.zip",
    bytes: 33_232_444,
    sha256: "384a798162f798fbe3dfb9060d7107d5a1703e1903d5cb5bba7dd3426e4130d5",
  },
} as const;

export interface CuaDriverRelease {
  readonly version: string;
  readonly archiveName: string;
  readonly format: "tar.gz" | "zip";
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly executable: string;
  readonly requiredFiles: ReadonlyArray<string>;
}

export function cuaDriverRelease(platform: NodeJS.Platform, arch: string): CuaDriverRelease | null {
  const key =
    platform === "darwin" && (arch === "arm64" || arch === "x64")
      ? "darwin-universal"
      : (platform === "linux" || platform === "win32") && (arch === "x64" || arch === "arm64")
        ? (`${platform}-${arch}` as const)
        : null;
  if (key === null) return null;
  const archive = archives[key];
  const executable = platform === "win32" ? "cua-driver.exe" : "cua-driver";
  return {
    version: CUA_DRIVER_VERSION,
    ...archive,
    format: platform === "win32" ? "zip" : "tar.gz",
    url: `https://github.com/goat-si/cua-driver/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${archive.archiveName}`,
    executable,
    requiredFiles: [
      executable,
      ...(platform === "win32"
        ? ["cua-driver-uia.exe", "cua-cursor-theme.exe", "cua_driver_sdk.dll"]
        : platform === "linux"
          ? [
              "cua-cursor-theme",
              "libcua_driver_sdk.so",
              "wayland-helper/install.sh",
              "wayland-helper/winrects@cua/metadata.json",
              "wayland-helper/winrects@cua/extension.js",
            ]
          : ["cua-cursor-theme", "libcua_driver_sdk.dylib"]),
      "cua_driver_node_runtime.node",
    ],
  };
}

// Direct launches force these values over inherited tuning, including the fork's switch that
// prevents Apple's screencapture tool from requesting audio access under the helper's identity.
const CUA_DRIVER_PRIVACY_ENVIRONMENT = [
  { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
  { name: "CUA_DRIVER_DISABLE_SCREENCAPTURE", value: "1" },
] as const;

/**
 * Names the Linux display probe decides for a standalone server. The embedded host copies
 * allowlisted names from GOAT's own environment before applying `environment` and cannot unset
 * one, so a name the probe did not supply is passed empty: D-Bus clients refuse an empty address
 * instead of dialing the bus the probe found dead.
 */
export const CUA_DRIVER_PROBED_SESSION_NAMES = ["DBUS_SESSION_BUS_ADDRESS"] as const;

/**
 * Options for `EmbeddedCuaDriverHost.withOptions`. The daemon runs in standard mode under GOAT's
 * capability manifest (cuaDriverManifest.ts); approving it here is GOAT acting as the trusted
 * launcher that reviewed the file it just wrote.
 * `display` carries the screen a server started over SSH must reach (DISPLAY, XAUTHORITY, the
 * D-Bus session bus), all on the embedded allowlist. The privacy switches always win.
 * npm SDK 0.37.0 rejects CUA_DRIVER_DISABLE_SCREENCAPTURE at construction, so it is dropped here;
 * an embedded driver keeps screencapture off when the variable is unset (goat-si/cua-driver#19).
 * `withheld` names the daemon must not inherit when `display` does not set them.
 */
export function cuaDriverHostOptions(
  binaryPath: string,
  hostBundleId: string,
  capabilityManifestPath: string,
  display: ReadonlyArray<{ readonly name: string; readonly value: string }> = [],
  withheld: ReadonlyArray<string> = [],
) {
  const privacy = new Set<string>(CUA_DRIVER_PRIVACY_ENVIRONMENT.map((variable) => variable.name));
  const supplied = new Set(display.map((variable) => variable.name.toUpperCase()));
  return {
    binaryPath,
    hostBundleId,
    // EmbeddedPermissionMode.Standard. Bounded mode ties authority to manifest lifetimes that
    // would end the shared daemon under interactive threads too (ADR-0022).
    permissionMode: 0,
    capabilityManifestPath,
    approveCapabilityManifest: true,
    approveSessionPolicy: false,
    dangerouslyBypassApprovals: false,
    environment: [
      ...display
        .filter((variable) => !privacy.has(variable.name.toUpperCase()))
        .map(({ name, value }) => ({ name, value })),
      ...withheld
        .filter((name) => !supplied.has(name.toUpperCase()))
        .map((name) => ({ name, value: "" })),
      ...CUA_DRIVER_PRIVACY_ENVIRONMENT.map((variable) => ({ ...variable })),
    ].filter((variable) => variable.name.toUpperCase() !== "CUA_DRIVER_DISABLE_SCREENCAPTURE"),
    inheritStderr: true,
    noOverlay: false,
  };
}

// Agents reach the daemon through a separate `cua-driver mcp` process that the provider spawns
// with this configuration, outside the embedded allowlist, so every opt-out applies there.
const MCP_PRIVACY_ENVIRONMENT = [
  ...CUA_DRIVER_PRIVACY_ENVIRONMENT,
  { name: "DO_NOT_TRACK", value: "1" },
  { name: "CUA_TELEMETRY", value: "0" },
] as const;

export function withCuaDriverPrivacyEnvironment<
  T extends {
    readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  },
>(mcp: T): T {
  const names = new Set<string>(MCP_PRIVACY_ENVIRONMENT.map((variable) => variable.name));
  return {
    ...mcp,
    environment: [
      ...mcp.environment.filter((variable) => !names.has(variable.name.toUpperCase())),
      ...MCP_PRIVACY_ENVIRONMENT.map((variable) => ({ ...variable })),
    ],
  };
}

// The short-lived listing process gets the session basics the driver needs to find apps and the
// display, plus every opt-out; nothing else from GOAT's environment.
const LISTING_ENVIRONMENT_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "USERPROFILE",
] as const;

export function cuaDriverListingEnvironment(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of LISTING_ENVIRONMENT_NAMES) {
    const value = base[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const variable of MCP_PRIVACY_ENVIRONMENT) environment[variable.name] = variable.value;
  return environment;
}
