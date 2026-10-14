import type {
  WorktreesDirectoryStatus,
  WorktreesDirectoryUnavailableReason,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import * as HostProcess from "@goat/shared/HostProcess";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting (`~` expands to `home`), or `defaultDir` (`<GOAT home>/worktrees`)
 * when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

/** Folders whose entries are mount points; a missing entry is a disconnected drive. */
const MOUNT_CONTAINERS = ["/Volumes", "/mnt", "/media", "/run/media"];

function isUnderMountContainer(directory: string, path: Path.Path): boolean {
  return MOUNT_CONTAINERS.some((container) => directory.startsWith(container + path.sep));
}

/**
 * Checks that `directory` can hold new worktrees, without creating anything.
 * A missing directory is fine when its parent is an existing, writable
 * folder, because `git worktree add` creates the leaf. Anything below a
 * mount container such as `/Volumes` must already exist: a missing entry
 * there means the drive is unmounted, and creating it would leave a stray
 * folder on the boot disk that shadows the drive when it comes back.
 */
export const checkWorktreesDirectory = Effect.fn("checkWorktreesDirectory")(function* (
  directory: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const writable = (target: string) =>
    fileSystem.access(target, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const info = yield* fileSystem.stat(directory).pipe(Effect.option);
  if (info._tag === "Some") {
    if (info.value.type !== "Directory") return "not-a-directory" as const;
    return (yield* writable(directory)) ? null : ("not-writable" as const);
  }
  if (isUnderMountContainer(directory, path)) {
    const parent = path.dirname(directory);
    // A drive's own root may be configured; it never gets created here.
    if (MOUNT_CONTAINERS.includes(parent) || path.dirname(parent) === "/run/media") {
      return "unmounted" as const;
    }
    if (!(yield* fileSystem.exists(parent).pipe(Effect.orElseSucceed(() => false)))) {
      return "unmounted" as const;
    }
  }
  const parent = path.dirname(directory);
  const parentInfo = yield* fileSystem.stat(parent).pipe(Effect.option);
  if (parentInfo._tag === "None" || parentInfo.value.type !== "Directory")
    return "missing" as const;
  return (yield* writable(parent)) ? null : ("not-writable" as const);
});

/**
 * Where the next worktree goes: the configured directory when it is usable,
 * else `defaultDir`, with the reason so callers can warn. The default
 * directory is not checked; it lives in GOAT home, which must be writable.
 */
export const resolveAvailableWorktreesDirectory = Effect.fn("resolveAvailableWorktreesDirectory")(
  function* (
    input: { readonly setting: string; readonly defaultDir: string },
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
  ) {
    const status = (
      directory: string,
      unavailable: {
        readonly reason: WorktreesDirectoryUnavailableReason;
        readonly path: string | null;
      } | null,
    ): WorktreesDirectoryStatus => ({ configured: input.setting, directory, unavailable });
    if (input.setting === "") return status(input.defaultDir, null);
    const home = yield* HostProcess.HomeDirectory;
    const configured = resolveWorktreesDirectory(input.setting, input.defaultDir, path, home);
    if (configured === null) return status(input.defaultDir, { reason: "invalid", path: null });
    const reason = yield* checkWorktreesDirectory(configured, fileSystem, path);
    return reason === null
      ? status(configured, null)
      : status(input.defaultDir, { reason, path: configured });
  },
);

/** Every directory that holds T3-managed worktrees on this machine. */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}
