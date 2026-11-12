const POSIX_PATH_DELIMITER = ":";

/** VS Code's default for the same probe (application.shellEnvironmentResolutionTimeout). */
export const POSIX_LOGIN_SHELL_PROBE_TIMEOUT_MS = 10_000;

/** Gaps before each further login-shell probe after one fails; the length bounds the retries. */
export const LOGIN_SHELL_RETRY_DELAYS_MS: ReadonlyArray<number> = [30_000, 120_000, 600_000];

/** Set by the desktop on its server until a login shell has answered with a PATH. */
const SHELL_DISCOVERY_PENDING_ENV = "GOAT_DESKTOP_SHELL_DISCOVERY_PENDING";

const LOGIN_SHELL_PATH_UNREAD_NOTE =
  "GOAT may not have your login shell's current PATH yet, so it may have searched only the folders it already knew and the standard install folders. If the CLI is installed somewhere else, set its full path as that provider's Binary path under Settings → Providers.";

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

export const loginShellPathUnread = (env: NodeJS.ProcessEnv): boolean =>
  env[SHELL_DISCOVERY_PENDING_ENV] === "1";

/**
 * One sentence for every "CLI not found" message, so providers cannot drift apart. Only macOS
 * and Linux read a login shell; Windows desktop sets the same variable for other reasons.
 */
export function withLoginShellPathNote(
  message: string,
  host: { readonly env: NodeJS.ProcessEnv; readonly platform: NodeJS.Platform },
): string {
  const readsLoginShell = host.platform === "darwin" || host.platform === "linux";
  return readsLoginShell && loginShellPathUnread(host.env)
    ? `${message} ${LOGIN_SHELL_PATH_UNREAD_NOTE}`
    : message;
}
