// The SDK and executable use a private protocol; bump the catalog pin with this manifest.
const CUA_DRIVER_VERSION = "0.37.0";

const archives = {
  "darwin-universal": {
    archiveName: "cua-driver-rs-0.37.0-darwin-universal-binary.tar.gz",
    bytes: 53_254_204,
    sha256: "7d491f67f54be5f3b380ffd85c64b242eaefd05dad6df78012cde227c95aee2a",
  },
  "linux-x64": {
    archiveName: "cua-driver-rs-0.37.0-linux-x86_64-binary.tar.gz",
    bytes: 36_941_258,
    sha256: "c7ac376b10da7c207e510b2d90b88a9588bec9852a237962c273fe81b9cd5623",
  },
  "linux-arm64": {
    archiveName: "cua-driver-rs-0.37.0-linux-arm64-binary.tar.gz",
    bytes: 36_518_124,
    sha256: "879e8040a4ce24caeee34b2e4ac6119be01661082202919db1bcc1ab0b97e4c8",
  },
  "win32-x64": {
    archiveName: "cua-driver-rs-0.37.0-windows-x86_64-binary.zip",
    bytes: 35_838_756,
    sha256: "40481b55073f1225b0010235b30217bd640ef1f323e982aec0a5f6131d3e4a99",
  },
  "win32-arm64": {
    archiveName: "cua-driver-rs-0.37.0-windows-arm64-binary.zip",
    bytes: 33_606_104,
    sha256: "0fce682b251775e25fd76bf29ff856f7f5ab5aae5759d6b76a40f8312a194a5a",
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
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/${archive.archiveName}`,
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

// The embedded host clears the driver's environment and rejects names outside its allowlist, so
// DO_NOT_TRACK and CUA_TELEMETRY cannot be forwarded. These allowlisted switches override any
// inherited value and turn off the driver's default-on telemetry and GitHub update check.
export const CUA_DRIVER_PRIVACY_ENVIRONMENT = [
  { name: "CUA_DRIVER_RS_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_TELEMETRY_ENABLED", value: "false" },
  { name: "CUA_DRIVER_RS_UPDATE_CHECK", value: "false" },
] as const;

/** Options for `EmbeddedCuaDriverHost.withOptions`; the rest match its two-argument constructor. */
export function cuaDriverHostOptions(binaryPath: string, hostBundleId: string) {
  return {
    binaryPath,
    hostBundleId,
    approveCapabilityManifest: false,
    approveSessionPolicy: false,
    dangerouslyBypassApprovals: false,
    environment: CUA_DRIVER_PRIVACY_ENVIRONMENT.map((variable) => ({ ...variable })),
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
