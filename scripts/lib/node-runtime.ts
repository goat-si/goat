// @effect-diagnostics nodeBuiltinImport:off - checks the runtime before Effect or any dependency loads.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ROOT_PACKAGE_JSON = NodePath.join(import.meta.dirname, "..", "..", "package.json");

/** The exact Node release the checkout pins for development and CI. */
export function readPinnedNodeVersion(): string {
  const manifest: { readonly engines?: { readonly node?: unknown } } = JSON.parse(
    NodeFS.readFileSync(ROOT_PACKAGE_JSON, "utf8"),
  );
  const pinned = manifest.engines?.node;
  if (typeof pinned !== "string" || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`${ROOT_PACKAGE_JSON} engines.node must be an exact x.y.z Node release.`);
  }
  return pinned;
}

/** Strips any "+..." integrity suffix from a package.json packageManager field. */
export function normalizePackageManager(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const stripped = value.split("+", 1)[0]?.trim();
  return stripped ? stripped : undefined;
}

/** The packageManager release root package.json pins (without any "+..." suffix), if any. */
export function readPinnedPackageManager(): string | undefined {
  const manifest: { readonly packageManager?: unknown } = JSON.parse(
    NodeFS.readFileSync(ROOT_PACKAGE_JSON, "utf8"),
  );
  return normalizePackageManager(manifest.packageManager);
}

const versionParts = (version: string) =>
  version.split(".").map((part) => Number.parseInt(part, 10));

/**
 * Development accepts the pinned release and later releases of its major.
 * The server's own wider range exists for Electron's Node 24 and is not a
 * development target: with vp in system-first mode a PATH Node such as 22
 * would otherwise fail every SQLite test one by one (#1647).
 */
export function unsupportedNodeMessage(input: {
  readonly version: string;
  readonly pinned: string;
  readonly execPath: string;
  readonly command: string;
  readonly packageManager?: string | undefined;
}): string | undefined {
  const [major = 0, minor = 0, patch = 0] = versionParts(input.version);
  const [pinnedMajor = 0, pinnedMinor = 0, pinnedPatch = 0] = versionParts(input.pinned);
  if (
    major === pinnedMajor &&
    (minor > pinnedMinor || (minor === pinnedMinor && patch >= pinnedPatch))
  ) {
    return undefined;
  }
  const packageManager = normalizePackageManager(input.packageManager);
  const packageManagerArgs = packageManager ? ` --package-manager ${packageManager}` : "";
  const packageManagerNote = packageManager ? " (vite-plus 0.3.1+)" : "";
  return [
    `GOAT development uses Node.js ${input.pinned} (engines.node in the root package.json), but ${input.execPath} is Node.js ${input.version}.`,
    `Run it with the pinned Node.js${packageManagerNote}: vp env exec --node ${input.pinned}${packageManagerArgs} -- ${input.command}`,
    "Or let vp manage Node.js again: vp env on node",
  ].join("\n");
}

export function currentUnsupportedNodeMessage(command: string): string | undefined {
  return unsupportedNodeMessage({
    version: process.versions.node,
    pinned: readPinnedNodeVersion(),
    execPath: process.execPath,
    command,
    packageManager: readPinnedPackageManager(),
  });
}

/**
 * Vitest global setup: one clear failure before any test worker starts. A
 * thrown error would follow a misleading "No test files found" report.
 */
export function setup(): void {
  const message = currentUnsupportedNodeMessage("vp test run");
  if (message === undefined) return;
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
