function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeCommandPath(commandPath: string): string {
  return commandPath.replaceAll("\\", "/").toLowerCase();
}

/**
 * Vite+ shims live in `<VP_HOME>/bin`: `~/.vite-plus` by default,
 * `~/.local/share/vite-plus` with the XDG layout, and `%LOCALAPPDATA%\vite-plus`
 * on Windows.
 */
export function isVitePlusGlobalCommandPath(commandPath: string): boolean {
  return /\/(?:\.vite-plus|\.local\/share\/vite-plus|appdata\/local\/vite-plus)\/bin\//.test(
    normalizeCommandPath(commandPath),
  );
}

export function isBunGlobalCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/.bun/bin/");
}

export function isYarnGlobalCommandPath(commandPath: string): boolean {
  return /\/yarn\/(?:data\/)?global\/node_modules\//.test(normalizeCommandPath(commandPath));
}

/** Version-manager installs are pinned in its config, so updating them means editing that. */
export function isMiseCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.includes("/mise/installs/") || normalized.includes("/mise/shims/");
}

const winGetClaudeCommandPath =
  /^[a-z]:\/(?:users\/[^/]+\/appdata\/local\/microsoft|program files(?: \(x86\))?)\/winget\/(?:links|packages\/anthropic\.claudecode_[^/]+)\/claude\.exe$/;

export function isWinGetClaudeCommandPath(commandPath: string): boolean {
  return winGetClaudeCommandPath.test(normalizeCommandPath(commandPath));
}

export const CHOCOLATEY_CLAUDE_PACKAGE_ID = "claude-code";

// Chocolatey's executable shim is not a symlink, so realpath cannot prove its owner.
const chocolateyClaudeCommandPath = /\/chocolatey\/(?:bin|lib\/claude-code\/tools)\/claude\.exe$/;

export function isChocolateyClaudeCommandPath(
  commandPath: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const normalized = normalizeCommandPath(commandPath);
  if (chocolateyClaudeCommandPath.test(normalized)) return true;
  const root = nonEmptyString(env.ChocolateyInstall);
  if (!root) return false;
  const prefix = normalizeCommandPath(root.replace(/[\\/]+$/, ""));
  return (
    normalized === `${prefix}/bin/claude.exe` ||
    normalized === `${prefix}/lib/claude-code/tools/claude.exe`
  );
}

/** `choco search --exact --limit-output` prints `<id>|<version>` for a match and nothing otherwise. */
export function parseChocolateyLatestVersion(output: string, packageId: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const [id, version] = line.trim().split("|", 2);
    if (id?.toLowerCase() === packageId.toLowerCase()) return nonEmptyString(version);
  }
  return null;
}

export function isPnpmGlobalCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.includes("/.local/share/pnpm/") ||
    normalized.includes("/library/pnpm/") ||
    normalized.includes("/local/share/pnpm/") ||
    normalized.includes("/appdata/local/pnpm/") ||
    normalized.includes("/pnpm/global/")
  );
}

export function npmGlobalPrefixFromCommandPath(
  realCommandPath: string,
  packageName: string,
): string | null {
  const slashPath = realCommandPath.replaceAll("\\", "/");
  const normalized = slashPath.toLowerCase();
  const packageSegment = `/lib/node_modules/${packageName.toLowerCase()}/`;
  const packageIndex = normalized.lastIndexOf(packageSegment);
  if (packageIndex < 0 || normalized.slice(0, packageIndex).includes("/node_modules/")) {
    return null;
  }
  // Mise tool layouts resemble npm globals; only globals under its Node install belong to npm.
  const miseTool = /\/mise\/installs\/([^/]+)\/[^/]+$/.exec(normalized.slice(0, packageIndex))?.[1];
  if (miseTool && miseTool !== "node") {
    return null;
  }
  return packageIndex === 0 ? "/" : slashPath.slice(0, packageIndex);
}
