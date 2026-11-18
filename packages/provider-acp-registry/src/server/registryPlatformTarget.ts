export type AcpRegistryPlatformTarget =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

export function resolveAcpRegistryPlatformTarget(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): AcpRegistryPlatformTarget | undefined {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : undefined;
  return os && arch ? (`${os}-${arch}` as AcpRegistryPlatformTarget) : undefined;
}

export function resolveAcpRegistryPlatformTargetCandidates(
  platformTarget: AcpRegistryPlatformTarget | undefined,
): ReadonlyArray<AcpRegistryPlatformTarget> {
  if (platformTarget === undefined) return [];
  // Windows 11 ARM can emulate x86_64 binaries when no native build exists.
  if (platformTarget === "windows-aarch64") {
    return ["windows-aarch64", "windows-x86_64"];
  }
  return [platformTarget];
}
