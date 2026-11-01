// @effect-diagnostics nodeBuiltinImport:off - Release tooling compares decoded JSON structures.
import * as NodeUtil from "node:util";
import {
  decodeRuntimeManifest,
  releaseRuntimeManifest,
  type RuntimeManifest,
} from "@goat/shared/runtimeManifest";

export function checkReleaseRuntimeManifest(
  source: string,
  version: string,
  checksums: ReadonlyMap<string, string>,
): string[] {
  const manifest = decodeRuntimeManifest(source);
  if (!manifest) return ["invalid runtime manifest"];
  if (manifest.version !== version) return ["runtime manifest version mismatch"];
  try {
    const expected = releaseRuntimeManifest(manifest, checksums);
    const archiveNames = [...checksums.keys()].filter((name) =>
      /^goat-.+-(?:darwin|linux|win32)-(?:arm64|x64)\.(?:tar\.gz|zip)$/.test(name),
    );
    const listed = new Set(
      Object.values(expected.platforms ?? {}).map((platform) => platform.asset),
    );
    if (
      archiveNames.some((name) => !listed.has(name)) ||
      !NodeUtil.isDeepStrictEqual(manifest.platforms, expected.platforms)
    )
      return ["runtime manifest platform archives/checksums mismatch"];
  } catch {
    return ["runtime manifest has no published platform archive"];
  }
  return [];
}

export function runtimeManifestMismatch(
  embedded: RuntimeManifest,
  binary: RuntimeManifest,
): boolean {
  return (["version", "protocol", "capabilities", "commitTime", "commit"] as const).some(
    (field) => !NodeUtil.isDeepStrictEqual(embedded[field], binary[field]),
  );
}
