import type { HostDiskUsage, HostLoadAverage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Where `fs.statfs` should look: the volume holding GOAT's home, where worktrees, builds and
 * GOAT's data fill the disk (on Linux /home or a GOAT_HOME elsewhere is often its own volume).
 * A relative path falls back to the root filesystem. Windows uses the folder's drive root; a path
 * without a drive letter is not passed to statfs, which throws on those paths.
 */
export function diskPathForPlatform(platform: NodeJS.Platform, dataDir: string): string | null {
  switch (platform) {
    case "linux":
    case "darwin":
      return dataDir.startsWith("/") ? dataDir : "/";
    case "win32": {
      const drive = /^([A-Za-z]:)/.exec(dataDir.replaceAll("/", "\\"));
      return drive === null ? null : `${drive[1]}\\`;
    }
    default:
      return null;
  }
}

/** Windows `os.loadavg()` is `[0, 0, 0]`, which is not a load average. */
export function loadAverageForPlatform(
  platform: NodeJS.Platform,
  loadavg: readonly number[],
): HostLoadAverage | null {
  switch (platform) {
    case "linux":
    case "darwin": {
      const [one, five, fifteen] = loadavg;
      if (
        one === undefined ||
        five === undefined ||
        fifteen === undefined ||
        !Number.isFinite(one) ||
        !Number.isFinite(five) ||
        !Number.isFinite(fifteen)
      ) {
        return null;
      }
      return { oneMinute: one, fiveMinutes: five, fifteenMinutes: fifteen };
    }
    case "win32":
      return null;
    default:
      return null;
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Bytes from a `statfs` sample. A Windows volume that cannot be queried
 * reports zero blocks; that is missing data, not an empty disk.
 */
export function diskFromStatfs(
  platform: NodeJS.Platform,
  path: string,
  stats: { readonly bsize: bigint; readonly blocks: bigint; readonly bavail: bigint },
): HostDiskUsage | null {
  if (stats.bsize <= 0n || stats.blocks < 0n || stats.bavail < 0n) return null;
  if (platform === "win32" && stats.blocks === 0n) return null;
  const total = stats.blocks * stats.bsize;
  const available = stats.bavail * stats.bsize;
  if (available > total || total > MAX_SAFE || available > MAX_SAFE) return null;
  return {
    path,
    availableBytes: Number(available),
    totalBytes: Number(total),
  };
}

export function readHostCapacityExtras(input: {
  readonly platform: NodeJS.Platform;
  /** GOAT's home folder; its volume is the disk sampled. */
  readonly dataDir: string;
  readonly loadavg: readonly number[];
  readonly statfs: (path: string) => Promise<{
    readonly bsize: bigint;
    readonly blocks: bigint;
    readonly bavail: bigint;
  }>;
}): Effect.Effect<{
  readonly loadAvg: HostLoadAverage | null;
  readonly disk: HostDiskUsage | null;
}> {
  return Effect.gen(function* () {
    const loadAvg = loadAverageForPlatform(input.platform, input.loadavg);
    const path = diskPathForPlatform(input.platform, input.dataDir);
    if (path === null) return { loadAvg, disk: null };
    // statfs throws ENOSYS on some Windows libuv builds, and a bad mount
    // should not fail the rest of the host sample.
    const stats = yield* Effect.tryPromise({
      try: () => input.statfs(path),
      catch: () => undefined,
    }).pipe(Effect.option);
    if (Option.isNone(stats)) return { loadAvg, disk: null };
    return { loadAvg, disk: diskFromStatfs(input.platform, path, stats.value) };
  });
}
