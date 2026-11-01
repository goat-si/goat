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

/**
 * The pinned Windows x64 release whose Remote Link accepts a Windows Child. Windows Child setup
 * stays refused until this GOAT build pins one.
 */
export const windowsRemoteLinkRelease = (
  catalog: OpenCodexReleaseCatalog = OPEN_CODEX_RELEASES,
  version: string = OPEN_CODEX_PINNED_VERSION,
) => {
  const release = resolveOpenCodexRelease("win32", "x64", version, catalog);
  return release?.remoteLinkWindows === true ? release : undefined;
};
export const WINDOWS_REMOTE_LINK_UNPINNED =
  "Windows Child setup needs a GOAT build that pins an OpenCodex release with Windows Remote Link support.";

/**
 * OpenCodex's remoteOcxArgv order: Desktop and system installs win over PATH shims. On Windows it
 * is Remote Link's own resolver order, so GOAT selects the ocx.exe a Home's link would run.
 */
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
  if (platform === "win32")
    return [
      ...new Set([
        path.join(home, ".opencodex-desktop", "bin", "ocx.exe"),
        path.join(home, ".local", "share", "goat", "opencodex", "current", "ocx.exe"),
        path.join(home, ".local", "bin", "ocx.exe"),
        ...(environment.LOCALAPPDATA
          ? [path.join(environment.LOCALAPPDATA, "Programs", "OpenCodex", "ocx.exe")]
          : []),
        ...(environment.ProgramFiles
          ? [path.join(environment.ProgramFiles, "OpenCodex", "ocx.exe")]
          : []),
        ...(environment.PATH ?? "")
          .split(";")
          .filter(Boolean)
          .map((directory) => path.resolve(cwd, directory, "ocx.exe")),
      ]),
    ];
  const directories = [
    ...(environment.PATH ?? "").split(":"),
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
      ...directories.map((directory) => path.resolve(cwd, directory || ".", "ocx")),
    ]),
  ];
}
