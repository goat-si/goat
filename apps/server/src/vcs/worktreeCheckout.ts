import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import { isWindowsReservedFileName, normalizeProjectPathForComparison } from "@goat/shared/path";

/**
 * The folder a new worktree gets for its branch. Git allows branch names Windows refuses as file
 * names (`"`, `<`, `|`, a trailing dot, `con`), so a Windows server replaces those as well.
 */
export function worktreeFolderName(branch: string, platform: NodeJS.Platform): string {
  const name = branch.replace(/\//g, "-");
  if (platform !== "win32") return name;
  const safe = name.replace(/[\\:*?"<>|]/gu, "-").replace(/[. ]+$/u, "") || "worktree";
  return isWindowsReservedFileName(safe) ? `${safe}-branch` : safe;
}

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

type WorktreeGit = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: { readonly allowNonZeroExit?: boolean },
) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, GitCommandError>;

const lenient = { allowNonZeroExit: true };
const output = (result: { readonly exitCode: number; readonly stdout: string }) =>
  result.exitCode === 0 ? result.stdout.trim() : "";

/**
 * Whether new linked worktrees of the checkout at `cwd` need their own `core.worktree`, and
 * whether a plain `git worktree add` would already resolve to the shared one while checking
 * out and running post-checkout, so the checkout has to follow the add.
 *
 * A repository whose checkout lives outside its git dir, as a submodule's does, sets
 * `core.worktree`. Linked worktrees ignore a shared one until `extensions.worktreeConfig` is
 * on, then inherit it unless they set their own. In a submodule's git dir the value is
 * `../../../<path>`: `sparse-checkout set` moves it into the main worktree's
 * `config.worktree`, which a linked checkout does not read, and the next
 * `git submodule update` writes it back, so a worktree without its own value resolves to, and
 * checks out into, the git dir itself (#799).
 */
export const readWorktreeRoot = Effect.fn("GitVcsDriver.createWorktree.readWorktreeRoot")(
  function* (
    git: WorktreeGit,
    path: Path.Path,
    cwd: string,
    hookRunSupported: Effect.Effect<boolean, GitCommandError>,
  ) {
    const operation = "GitVcsDriver.createWorktree.readWorktreeRoot";
    const read = (args: readonly string[]) =>
      git(operation, cwd, args, lenient).pipe(Effect.map(output));
    let pin = (yield* read(["config", "--get-all", "core.worktree"])) !== "";
    if (!pin) {
      const [gitDir = "", commonDir = ""] = (yield* read([
        "rev-parse",
        "--absolute-git-dir",
        "--git-common-dir",
      ])).split("\n");
      const common = path.resolve(cwd, commonDir);
      const mainConfig = path.join(common, "config.worktree");
      pin =
        commonDir !== "" &&
        normalizeProjectPathForComparison(common) !== normalizeProjectPathForComparison(gitDir) &&
        (yield* read(["config", "--file", mainConfig, "--get", "core.worktree"])) !== "";
    }
    if (!pin) return { pin, checkoutApart: false };
    // Git applies its own boolean rules and precedence.
    const checkoutApart =
      (yield* read(["config", "--bool", "--get", "extensions.worktreeConfig"])) === "true";
    if (checkoutApart && !(yield* hookRunSupported)) {
      return yield* new GitCommandError({
        operation,
        command: "git hook run",
        cwd,
        detail:
          "This checkout's worktrees would check out and run post-checkout in its git dir, and this Git lacks git hook run to check out first; install Git 2.36 or later.",
      });
    }
    return { pin, checkoutApart };
  },
);

/**
 * Points `git hook run` at the source checkout's hooks directory by absolute path, where
 * `git worktree add` runs post-checkout from. A relative `core.hooksPath`, such as a
 * generated and untracked one, would otherwise resolve inside the new worktree.
 */
export const sourceHooksConfig = Effect.fn("GitVcsDriver.createWorktree.sourceHooksConfig")(
  function* (git: WorktreeGit, path: Path.Path, cwd: string) {
    const hooks = (yield* git("GitVcsDriver.createWorktree.sourceHooksConfig", cwd, [
      "rev-parse",
      "--git-path",
      "hooks",
    ])).stdout.trim();
    return ["-c", `core.hooksPath=${path.resolve(cwd, hooks)}`];
  },
);

/**
 * Gives a new linked worktree its own `core.worktree` (see `readWorktreeRoot`), then checks
 * that it resolves to itself. The value goes into that worktree's `config.worktree` by name:
 * `git config --worktree` writes the shared config when `extensions.worktreeConfig` is off,
 * which would move the original checkout's root. Git reads the file only once the extension
 * is on, so the value also holds after a later sparse checkout turns it on.
 */
export const pinWorktreeRoot = Effect.fn("GitVcsDriver.createWorktree.pinWorktreeRoot")(function* (
  git: WorktreeGit,
  fileSystem: FileSystem.FileSystem,
  worktreePath: string,
) {
  const operation = "GitVcsDriver.createWorktree.pinWorktreeRoot";
  const gitDir = (yield* git(operation, worktreePath, [
    "rev-parse",
    "--absolute-git-dir",
  ])).stdout.trim();
  yield* git(operation, worktreePath, [
    "config",
    "--file",
    `${gitDir}/config.worktree`,
    "core.worktree",
    worktreePath,
  ]);
  const root = (yield* git(operation, worktreePath, [
    "rev-parse",
    "--show-toplevel",
  ])).stdout.trim();
  const resolve = (target: string) =>
    fileSystem.realPath(target).pipe(
      Effect.orElseSucceed(() => target),
      Effect.map(normalizeProjectPathForComparison),
    );
  if ((yield* resolve(root)) === (yield* resolve(worktreePath))) return;
  return yield* new GitCommandError({
    operation,
    command: "git rev-parse --show-toplevel",
    cwd: worktreePath,
    detail: `The new worktree resolves to ${root} instead of itself; check core.worktree in ${gitDir}/config.worktree`,
  });
});
