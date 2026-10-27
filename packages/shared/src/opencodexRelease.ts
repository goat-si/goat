import { OPEN_CODEX_RELEASE_PINS } from "./opencodexReleasePins.ts";
import { compareSemverVersions, parseSemver } from "./semver.ts";

/** Remote Link's floor for a Child. A Child never has to match its Home's version. */
export const CHILD_MINIMUM_VERSION = "2.66.0";
/** The release a fresh machine gets; the pin table keeps older rows for rollback. */
export const OPEN_CODEX_PINNED_VERSION = "2.92.0";

export interface OpenCodexRelease {
  readonly version: string;
  readonly target: string;
  readonly url: string;
  readonly sha256: string;
  readonly archiveBytes: number;
  readonly publishedAt: string;
  readonly layout: { readonly executable: string; readonly gui: string; readonly keyring: string };
  /** Whether this release's Remote Link accepts a Windows Child. */
  readonly remoteLinkWindows: boolean;
}
export type OpenCodexReleaseCatalog = Readonly<
  Record<string, Readonly<Record<string, OpenCodexRelease>>>
>;
export const OPEN_CODEX_RELEASES: OpenCodexReleaseCatalog = OPEN_CODEX_RELEASE_PINS;

/** `ocx --version` prints `opencodex 2.92.0`; older builds print the bare version. */
export const parseOpenCodexVersion = (text: string) =>
  text.trim().match(/^(?:ocx\s+|OpenCodex\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/iu)?.[1];

export const supportedOpenCodexVersion = (version: string) =>
  parseSemver(version) !== null && compareSemverVersions(version, CHILD_MINIMUM_VERSION) >= 0;

/** The reviewed archive for this machine; undefined when GOAT pins none for it. */
export const resolveOpenCodexRelease = (
  platform: string,
  arch: string,
  version: string = OPEN_CODEX_PINNED_VERSION,
  catalog: OpenCodexReleaseCatalog = OPEN_CODEX_RELEASES,
): OpenCodexRelease | undefined => catalog[version]?.[`${platform}-${arch}`];

/** OpenCodex's remoteOcxArgv order: Desktop and system installs win over PATH shims. */
export function openCodexCandidates(
  platform: string,
  home: string,
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  path: {
    readonly join: (...parts: Array<string>) => string;
    readonly resolve: (...parts: Array<string>) => string;
  },
): ReadonlyArray<string> {
  const directories = [
    ...(environment.PATH ?? "").split(platform === "win32" ? ";" : ":"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return [
    ...new Set([
      path.join(home, ".opencodex-desktop", "bin", "ocx"),
      "/Applications/OpenCodex.app/Contents/MacOS/ocx",
      "/usr/bin/ocx",
      ...directories.flatMap((directory) =>
        platform === "win32"
          ? ["ocx.exe", "ocx.cmd", "ocx.bat", "ocx"].map((name) =>
              path.resolve(cwd, directory || ".", name),
            )
          : [path.resolve(cwd, directory || ".", "ocx")],
      ),
    ]),
  ];
}
