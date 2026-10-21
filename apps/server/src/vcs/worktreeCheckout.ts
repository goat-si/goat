/**
 * Paths a project keeps out of its thread worktrees, as `git sparse-checkout --no-cone`
 * patterns: everything at the top level, minus each excluded directory. CI checks this
 * repository out with the same patterns. Cone mode cannot drop one directory without
 * listing all of its siblings, and with two patterns the non-cone matching cost Git warns
 * about is negligible. Null when nothing valid is excluded.
 */
export function worktreeSparseCheckoutPatterns(exclude: ReadonlyArray<string>): string | null {
  const directories = new Set<string>();
  for (const entry of exclude) {
    const directory = entry
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(?:\.\/)+/u, "")
      .replace(/^\/+|\/+$/gu, "");
    // Pattern characters or parent segments would exclude something other than the
    // named directory, so such an entry is ignored rather than guessed at.
    if (
      directory.length === 0 ||
      /[*?[\]!#\n\r]/u.test(directory) ||
      directory.split("/").some((segment) => segment === "." || segment === ".." || segment === "")
    ) {
      continue;
    }
    directories.add(directory);
  }
  if (directories.size === 0) return null;
  return ["/*", ...[...directories].map((directory) => `!/${directory}/`)].join("\n") + "\n";
}

/**
 * Repository-local settings GOAT turns on for Windows checkouts when no config level sets
 * them. Neither changes commit contents: the file-system cache batches the NTFS stat calls
 * that dominate Windows checkouts, and long paths let deep vendored trees check out at all.
 * The untracked cache is left alone because Scalar turns it off on Windows, where new files
 * do not always update their directory's mtime.
 */
export const WINDOWS_CHECKOUT_SETTINGS = [
  { key: "core.fscache", value: "true" },
  { key: "core.longpaths", value: "true" },
] as const;

export function missingWindowsCheckoutSettings(
  current: (key: string) => string | null,
): ReadonlyArray<(typeof WINDOWS_CHECKOUT_SETTINGS)[number]> {
  return WINDOWS_CHECKOUT_SETTINGS.filter((setting) => current(setting.key) === null);
}

/**
 * Parallel checkout workers when the repository does not choose. `0` means one per core,
 * which Git for Windows before 2.56 can crash with on many-core machines ("stack smashing
 * detected", git-for-windows/git#6395), so Windows gets a fixed count measured as fast.
 */
export function defaultCheckoutWorkers(platform: NodeJS.Platform): string {
  return platform === "win32" ? "8" : "0";
}
