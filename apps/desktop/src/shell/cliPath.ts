// Lifted from GOAT v1 packages/shared/src/cliPath.ts (origin/dev 916b5ccc1b2): verbatim except the retry delays and
// the "PATH not read yet" provider note (no provider messages in the shell).
const POSIX_PATH_DELIMITER = ":";

/** VS Code's default for the same probe (application.shellEnvironmentResolutionTimeout). */
export const POSIX_LOGIN_SHELL_PROBE_TIMEOUT_MS = 10_000;


// Never trimmed: a folder name may end in a space.
const withoutTrailingSlash = (entry: string): string => entry.replace(/(?<=.)\/+$/u, "");

/**
 * Where vendor installers put CLIs without a shell profile's help: ~/.local/bin (Claude Code,
 * Codex, Cursor), ~/.bun/bin (bun), Homebrew's default prefix, and npm's usual /usr/local.
 * Absolute folders only, per-user first; empty off macOS and Linux. A home that is not absolute,
 * is the root, or holds the PATH delimiter gets no per-user folders: it would add relative entries.
 */
export function wellKnownCliDirs(
  platform: NodeJS.Platform,
  home: string | undefined,
): ReadonlyArray<string> {
  if (platform !== "darwin" && platform !== "linux") return [];
  const root = withoutTrailingSlash(home ?? "");
  const perUser = root.startsWith("/") && root !== "/" && !root.includes(POSIX_PATH_DELIMITER);
  return [
    ...(perUser ? [`${root}/.local/bin`, `${root}/.bun/bin`] : []),
    platform === "darwin" ? "/opt/homebrew/bin" : "/home/linuxbrew/.linuxbrew/bin",
    "/usr/local/bin",
  ];
}

/**
 * Adds the well-known folders after everything already on PATH, so they never reorder or shadow
 * what the person's shell chose. They are added whether or not they exist yet: an installer run
 * later creates them. A missing PATH stays missing, since naming only these would hide /usr/bin.
 * The existing value is never rewritten: an empty component means the working directory.
 */
export function appendWellKnownCliDirs<Value extends string | null | undefined>(
  pathValue: Value,
  platform: NodeJS.Platform,
  home: string | undefined,
): Value | string {
  if (!pathValue) return pathValue;
  const present = new Set(pathValue.split(POSIX_PATH_DELIMITER).map(withoutTrailingSlash));
  const missing = wellKnownCliDirs(platform, home).filter((directory) => !present.has(directory));
  if (missing.length === 0) return pathValue;
  return [pathValue, ...missing].join(POSIX_PATH_DELIMITER);
}
