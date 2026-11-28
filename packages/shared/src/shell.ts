export { mergePathEntries } from "./shellPathEntries.ts";
import { npmShimExecutableAsync, preferGitForWindowsBinaryAsync } from "./windowsExecutableShim.ts";
export {
  gitForWindowsBash,
  gitForWindowsBashAsync,
  npmShimExecutable,
  preferGitForWindowsBinary,
} from "./windowsExecutableShim.ts";
export { runsGitWithoutConsole } from "./gitWindowsReads.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type { ShellEnvironmentPatch } from "@goat/contracts";
import * as HostProcess from "./HostProcess.ts";
import {
  buildEnvironmentCaptureCommand,
  buildWindowsEnvironmentCaptureCommand,
  extractEnvironmentValue,
  extractEnvironmentValues,
} from "./shellEnvironmentCapture.ts";
export {
  buildEnvironmentCaptureCommand,
  extractEnvironmentValues,
} from "./shellEnvironmentCapture.ts";
export { windowsEnvironmentValueCommand } from "./windowsTelemetryValueSelection.ts";
import { locateXcodeGitWithXcrun } from "./macosGit.ts";
import * as Context from "effect/Context";
const WINDOWS_PATH_DELIMITER = ";";
const POSIX_PATH_DELIMITER = ":";
const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const WINDOWS_SHELL_PROBE_TIMEOUT_MS = 5000;
// A shell stuck in the kernel survives the kill and holds stdout, so execFile's callback never fires.
const WINDOWS_SHELL_PROBE_DEADLINE = Duration.millis(WINDOWS_SHELL_PROBE_TIMEOUT_MS + 1000);

type ExecFileSyncLike = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    encoding: "utf8";
    timeout: number;
    readonly killSignal?: NodeJS.Signals | number;
    detached?: true;
    stdio?: ["ignore", "pipe", "ignore"];
  },
) => string;

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export type CommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;

const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

// Escape dynamic arguments for both cmd.exe and the target's CommandLineToArgvW parsing.
function escapeWindowsShellArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined | Promise<string | undefined>;

async function resolveSpawnExecutableWithNode(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const candidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );
  const isExecutable = async (candidate: string) => {
    try {
      if (!(await NodeFS.promises.stat(candidate)).isFile()) return false;
      if (platform === "win32") {
        return windowsPathExtensions.includes(path.extname(candidate).toUpperCase());
      }
      await NodeFS.promises.access(candidate, NodeFS.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) return candidate;
    }
    return undefined;
  }

  const pathValue = readEnvPath(env) ?? "";
  for (const pathEntry of pathValue.split(pathDelimiterForPlatform(platform))) {
    // A raw empty component of a nonempty POSIX PATH is the current directory.
    const emptyComponent = pathEntry === "" && pathValue !== "" && platform !== "win32";
    const normalizedPathEntry = emptyComponent ? "." : normalizePathEntry(pathEntry, platform);
    if (normalizedPathEntry.length === 0) continue;
    for (const candidate of candidates) {
      const candidatePath = path.join(normalizedPathEntry, candidate);
      // Anchored before the probe: callers may launch it from another cwd or through a wrapper,
      // and the cwd can change while the probe waits.
      let probePath = candidatePath;
      if (emptyComponent) {
        try {
          probePath = path.resolve(candidatePath);
        } catch {
          continue;
        }
      }
      if (await isExecutable(probePath)) return probePath;
    }
  }
  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@goat/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

export interface WindowsEnvironmentProbeOptions {
  readonly loadProfile?: boolean;
}

function trimNonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUserLoginShell(): string | undefined {
  try {
    return trimNonEmpty(NodeOS.userInfo().shell);
  } catch {
    return undefined;
  }
}

export function listLoginShellCandidates(
  platform: NodeJS.Platform,
  shell: string | undefined,
  userShell = readUserLoginShell(),
): ReadonlyArray<string> {
  const fallbackShell =
    platform === "darwin" ? "/bin/zsh" : platform === "linux" ? "/bin/bash" : undefined;
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [trimNonEmpty(shell), trimNonEmpty(userShell), fallbackShell]) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }

  return candidates;
}

export function readPathFromLaunchctl(
  execFile: ExecFileSyncLike = NodeChildProcess.execFileSync,
): string | undefined {
  try {
    const value = execFile("/bin/launchctl", ["getenv", "PATH"], {
      encoding: "utf8",
      timeout: 2000,
    }).replace(/\r?\n$/, "");
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export type ShellEnvironmentReader = (
  shell: string,
  names: ReadonlyArray<string>,
  execFile?: ExecFileSyncLike,
) => Partial<Record<string, string>>;

export const readEnvironmentFromLoginShell: ShellEnvironmentReader = (
  shell,
  names,
  execFile = NodeChildProcess.execFileSync,
) => {
  if (names.length === 0) {
    return {};
  }

  // Interactive startup loads PATH entries; detaching prevents job control on an
  // inherited controlling TTY from stopping the probe while the parent waits.
  const output = execFile(shell, ["-ilc", buildEnvironmentCaptureCommand(shell, names)], {
    encoding: "utf8",
    timeout: 5000,
    // Interactive shells can ignore SIGTERM, the default timeout signal.
    killSignal: "SIGKILL",
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  return extractEnvironmentValues(output, names);
};

export type WindowsShellEnvironmentReader = (
  names: ReadonlyArray<string>,
  options?: WindowsEnvironmentProbeOptions,
) => Effect.Effect<Partial<Record<string, string>>>;

export const WindowsShellEnvironment = Context.Reference<WindowsShellEnvironmentReader>(
  "@goat/shared/shell/WindowsShellEnvironment",
  {
    defaultValue: () => readEnvironmentFromWindowsShell,
  },
);

export const CommandAvailability = Context.Reference<CommandAvailabilityChecker>(
  "@goat/shared/shell/CommandAvailability",
  {
    defaultValue: () => isCommandAvailable,
  },
);

const execWindowsEnvironmentProbe = (
  file: string,
  args: ReadonlyArray<string>,
  options: { encoding: "utf8"; timeout: number },
) =>
  Effect.callback<Option.Option<string>>((resume) => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.execFile(
        file,
        args,
        { ...options, windowsHide: true },
        (error, stdout) => {
          resume(Effect.succeed(error ? Option.none() : Option.some(stdout)));
        },
      );
    } catch {
      resume(Effect.succeedNone);
      return;
    }
    return Effect.sync(() => {
      child.kill();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    });
  });

export const readEnvironmentFromWindowsShell = Effect.fn("shell.readEnvironmentFromWindowsShell")(
  function* (
    names: ReadonlyArray<string>,
    options: WindowsEnvironmentProbeOptions = {},
    execFile: typeof execWindowsEnvironmentProbe = execWindowsEnvironmentProbe,
  ) {
    if (names.length === 0) return {};

    const command = buildWindowsEnvironmentCaptureCommand(names);
    const args = [
      "-NoLogo",
      ...(options.loadProfile ? ([] as const) : (["-NoProfile"] as const)),
      "-NonInteractive",
      "-Command",
      command,
    ];
    for (const shell of WINDOWS_SHELL_CANDIDATES) {
      const output = yield* execFile(shell, args, {
        encoding: "utf8",
        timeout: WINDOWS_SHELL_PROBE_TIMEOUT_MS,
      }).pipe(Effect.timeoutOption(WINDOWS_SHELL_PROBE_DEADLINE), Effect.map(Option.flatten));
      if (Option.isNone(output)) continue;

      const environment: Partial<Record<string, string>> = {};
      for (const name of names) {
        const value = extractEnvironmentValue(output.value, name);
        if (value !== undefined) environment[name] = value;
      }
      return environment;
    }

    return {};
  },
);

function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.trim().replace(/^"+|"+$/g, "") : value;
}

function pathDelimiterForPlatform(platform: NodeJS.Platform): string {
  return platform === "win32" ? WINDOWS_PATH_DELIMITER : POSIX_PATH_DELIMITER;
}

function normalizePathEntryForComparison(entry: string, platform: NodeJS.Platform): string {
  const normalized = normalizePathEntry(entry, platform);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sanitizePathEntry(entry: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? entry.replaceAll('"', "") : entry;
}

export function mergePathValues(
  preferredPath: string | undefined,
  inheritedPath: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  const delimiter = pathDelimiterForPlatform(platform);
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const rawValue of [preferredPath, inheritedPath]) {
    if (!rawValue) continue;

    for (const entry of rawValue.split(delimiter)) {
      const sanitized = sanitizePathEntry(platform === "win32" ? entry.trim() : entry, platform);
      if (sanitized.length === 0) continue;

      const normalized = normalizePathEntryForComparison(sanitized, platform);
      if (normalized.length === 0 || seen.has(normalized)) continue;

      seen.add(normalized);
      merged.push(sanitized);
    }
  }

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}

function readEnvPath(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return readEnvPath(env) ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue =
    env.PATHEXT ??
    Object.entries(env).find(
      ([key, value]) => key.toUpperCase() === "PATHEXT" && value !== undefined,
    )?.[1];
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed: string[] = [];
  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }
  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  extname: (path: string) => string,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

// Explicit paths bypass the cache for new installs; cached misses can otherwise hide binaries for 30 seconds.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;
const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;
const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@goat/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

interface PathDirectoryListing {
  readonly modified: number | null | undefined;
  readonly names: ReadonlySet<string> | undefined;
}

const directoryMtime = (directory: string) =>
  FileSystem.FileSystem.use((fileSystem) => fileSystem.stat(directory)).pipe(
    Effect.map((info) =>
      info.type === "Directory" ? Option.getOrUndefined(info.mtime)?.getTime() : undefined,
    ),
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : undefined)),
  );

// Timestamp before reading so concurrent additions change the next mtime check; missing listings fall back to direct probes.
const listPathDirectory = Effect.fnUntraced(function* (
  directory: string,
): Effect.fn.Return<PathDirectoryListing, never, FileSystem.FileSystem> {
  const modified = yield* directoryMtime(directory);
  if (modified == null) return { modified, names: modified === null ? new Set() : undefined };
  const entries = yield* FileSystem.FileSystem.use((fileSystem) =>
    fileSystem.readDirectory(directory),
  ).pipe(Effect.orElseSucceed(() => undefined));
  return { modified, names: entries && new Set(entries.map((entry) => entry.toLowerCase())) };
});

const PathDirectoryListings = Context.Reference<
  Cache.Cache<string, PathDirectoryListing, never, FileSystem.FileSystem> | undefined
>("@goat/shared/shell/PathDirectoryListings", { defaultValue: () => undefined });

export const withPathDirectoryListings =
  /* Directory reads are cached inside one shell operation; a span for each lookup adds noise. */
  Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
    const listings = yield* Cache.make({
      capacity: 1024,
      lookup: listPathDirectory,
      requireServicesAt: "lookup",
    });
    return yield* effect.pipe(Effect.provideService(PathDirectoryListings, listings));
  });

// An injected resolver or locator may answer differently for the same search, so its
// entries are kept apart from every other resolver's.
let spawnResolverCacheIdCount = 0;
const spawnResolverCacheIds = new WeakMap<SpawnExecutableResolver | XcodeGitLocator, number>();
function spawnResolverCacheId(resolver: SpawnExecutableResolver | XcodeGitLocator): number {
  const known = spawnResolverCacheIds.get(resolver);
  if (known !== undefined) return known;
  const id = spawnResolverCacheIdCount++;
  spawnResolverCacheIds.set(resolver, id);
  return id;
}

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

const isExecutableFile = Effect.fnUntraced(function* (
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (stat === null || stat.type !== "File") return false;

  if (platform === "win32") {
    const extension = path.extname(filePath);
    if (extension.length === 0) return false;
    return windowsPathExtensions.includes(extension.toUpperCase());
  }

  return canExecuteFile(filePath);
});

// Keep case variants: Windows can make PATH directories case-sensitive.
function pathEntriesForPlatform(pathValue: string, platform: NodeJS.Platform): string[] {
  const pathEntries: string[] = [];
  const seenPathEntries = new Set<string>();
  for (const entry of pathValue.split(pathDelimiterForPlatform(platform))) {
    // A raw empty component of a nonempty POSIX PATH is the current directory.
    const pathEntry =
      entry === "" && pathValue !== "" && platform !== "win32"
        ? "."
        : normalizePathEntry(entry, platform);
    if (pathEntry.length === 0 || seenPathEntries.has(pathEntry)) continue;

    seenPathEntries.add(pathEntry);
    pathEntries.push(pathEntry);
  }
  return pathEntries;
}

// Relative POSIX PATH entries resolve against the working directory, so caches keyed by them include it.
// null: a relative entry is present but the working directory cannot be read, so nothing is cached.
function pathSearchCwd(pathValue: string, platform: NodeJS.Platform): string | null | undefined {
  if (platform === "win32") return undefined;
  if (
    pathEntriesForPlatform(pathValue, platform).every((entry) => NodePath.posix.isAbsolute(entry))
  ) {
    return undefined;
  }
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

// Called within the traced command resolvers.
const findOnPath = Effect.fnUntraced(function* (
  pathValue: string,
  commandCandidates: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  isLast: (match: string) => boolean,
  // The caller's snapshot, so a cache key and the search it stores agree on the directory.
  cwd: string | null | undefined,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const pathEntries = pathEntriesForPlatform(pathValue, platform);

  // A match through an empty component is anchored: callers may launch it from another cwd or
  // through a wrapper. A literal "." keeps its relative spelling; the first of the two wins, as
  // in the deduplicated walk.
  const anchorsCwd =
    typeof cwd === "string" &&
    pathValue
      .split(pathDelimiterForPlatform(platform))
      .find((entry) => entry === "" || entry === ".") === "";

  const listings = yield* PathDirectoryListings;
  const matches: string[] = [];
  for (const pathEntry of pathEntries) {
    let listing = listings && (yield* Cache.get(listings, pathEntry));
    if (listings && listing?.names && listing.modified !== (yield* directoryMtime(pathEntry))) {
      yield* Cache.invalidate(listings, pathEntry);
      listing = yield* Cache.get(listings, pathEntry);
    }
    for (const candidate of commandCandidates) {
      if (listing?.names && !listing.names.has(candidate.toLowerCase())) continue;
      // Probe what is returned: other relative entries stay relative, since the cached cwd
      // spelling goes stale when the directory is renamed.
      const match =
        anchorsCwd && pathEntry === "."
          ? path.join(cwd, candidate)
          : path.join(pathEntry, candidate);
      if (yield* isExecutableFile(match, platform, windowsPathExtensions)) {
        matches.push(match);
        if (isLast(match)) return matches;
        break;
      }
    }
  }
  return matches;
});

const resolveCommandPathForPlatform = Effect.fn("shell.resolveCommandPathForPlatform")(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly platform: NodeJS.Platform },
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = options.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const commandCandidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of commandCandidates) {
      if (yield* isExecutableFile(candidate, platform, windowsPathExtensions)) {
        return candidate;
      }
    }
    return null;
  }

  const pathValue = resolvePathEnvironmentVariable(env);
  if (pathValue.length === 0) {
    return null;
  }

  const cwd = pathSearchCwd(pathValue, platform);
  const cacheKey = [
    platform,
    pathValue,
    windowsPathExtensions.join(";"),
    command,
    ...(cwd === undefined ? [] : [cwd]),
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const cache = yield* CommandResolutionCache;
  const nowNanos = yield* Clock.monotonicTimeNanos;
  const cached = cwd === null ? undefined : cache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    return cached.resolvedPath;
  }

  const [resolvedPath = null] = yield* findOnPath(
    pathValue,
    commandCandidates,
    platform,
    windowsPathExtensions,
    () => true,
    cwd,
  );
  if (cwd !== null) cacheCommandResolution(cache, cacheKey, resolvedPath, nowNanos);
  return resolvedPath;
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPathForPlatform(command, {
    env: options.env ?? (yield* HostProcess.Environment),
    platform: yield* HostProcess.Platform,
  });
});

// Matches for a bare command in PATH order, up to the first one `until` accepts; not cached.
export const resolveCommandPaths = Effect.fn("shell.resolveCommandPaths")(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly until: (match: string) => boolean },
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const env = options.env ?? (yield* HostProcess.Environment);
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];
  const pathValue = resolvePathEnvironmentVariable(env);
  return yield* findOnPath(
    pathValue,
    resolveCommandCandidates(command, platform, windowsPathExtensions, path.extname),
    platform,
    windowsPathExtensions,
    options.until,
    pathSearchCwd(pathValue, platform),
  );
});

export type XcodeGitLocator = (env: NodeJS.ProcessEnv) => Effect.Effect<string | undefined>;

export const XcodeGitLocation = Context.Reference<XcodeGitLocator>(
  "@goat/shared/shell/XcodeGitLocation",
  { defaultValue: () => locateXcodeGitWithXcrun },
);

const MACOS_GIT_SHIM = "/usr/bin/git";

const MacosGitResolutionLock = Context.Reference("@goat/shared/shell/MacosGitResolutionLock", {
  defaultValue: () => Semaphore.makeUnsafe(1),
});

/**
 * Skip the xcrun shim's per-spawn lookup only when git resolves to /usr/bin/git.
 * User-selected git on PATH still wins, children keep PATH, and lookup failures use `git`.
 */
const resolveMacosGit = Effect.fn("shell.resolveMacosGit")(function* (
  env: NodeJS.ProcessEnv,
  resolveExecutable: SpawnExecutableResolver,
) {
  const lock = yield* MacosGitResolutionLock;
  return yield* lock.withPermits(1)(
    Effect.gen(function* () {
      const locateXcodeGit = yield* XcodeGitLocation;
      const cache = yield* CommandResolutionCache;
      const pathValue = resolvePathEnvironmentVariable(env);
      const nowNanos = yield* Clock.currentTimeNanos;
      // Read after the clock, so the lookup below starts in the directory the key names.
      const cwd = pathSearchCwd(pathValue, "darwin");
      const cacheKey = [
        "xcode-git",
        String(spawnResolverCacheId(resolveExecutable)),
        String(spawnResolverCacheId(locateXcodeGit)),
        pathValue,
        env.DEVELOPER_DIR ?? "",
        ...(cwd === undefined ? [] : [cwd]),
      ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
      const cached = cwd === null ? undefined : cache.get(cacheKey);
      // An Xcode update or removal deletes the binary; look again instead of failing the spawn.
      if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
        const cachedPath = cached.resolvedPath;
        if (
          cachedPath === null ||
          (yield* Effect.promise(async () => resolveExecutable(cachedPath, "darwin", env))) !==
            undefined
        ) {
          return cachedPath ?? "git";
        }
      }
      const pathGit = yield* Effect.promise(async () => resolveExecutable("git", "darwin", env));
      const located = pathGit === MACOS_GIT_SHIM ? yield* locateXcodeGit(env) : undefined;
      const realGit =
        located !== undefined &&
        (yield* Effect.promise(async () => resolveExecutable(located, "darwin", env))) !== undefined
          ? located
          : // A match anchored to the cwd came through an empty PATH entry, which a child would search
            // again from its own cwd; launch the file that was checked instead of bare `git`.
            typeof cwd === "string" && pathGit === NodePath.posix.join(cwd, "git")
            ? pathGit
            : null;
      // The lookups above await and the cwd can move meanwhile; cache only what the key's cwd found.
      if (cwd !== null && pathSearchCwd(pathValue, "darwin") === cwd) {
        cacheCommandResolution(cache, cacheKey, realGit, yield* Clock.currentTimeNanos);
      }
      return realGit ?? "git";
    }),
  );
});

export interface SpawnCommandOptions extends CommandAvailabilityOptions {
  /** Bypass npm cmd-shims; see npmShimExecutable for process-lifetime semantics. */
  readonly bypassNpmShim?: boolean;
}

export const resolveSpawnCommand = Effect.fnUntraced(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnCommandOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcess.Platform;
  const isMacosGit = platform === "darwin" && command === "git";
  if (platform !== "win32" && !isMacosGit) {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcess.Environment;
  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;
  const resolveExecutable = yield* SpawnExecutableResolution;
  if (isMacosGit) {
    return {
      command: yield* resolveMacosGit(env, resolveExecutable),
      args: [...args],
      shell: false,
    };
  }
  // Explicit paths and misses stay uncached so newly installed executables are discoverable.
  const explicitPath = command.includes("/") || command.includes("\\");
  const cache = yield* CommandResolutionCache;
  const cacheKey = [
    "spawn",
    String(spawnResolverCacheId(resolveExecutable)),
    platform,
    resolvePathEnvironmentVariable(env),
    resolveWindowsPathExtensions(env).join(";"),
    env.MSYSTEM ? "msystem" : "",
    command,
  ].join(COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR);
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = explicitPath ? undefined : cache.get(cacheKey);
  let resolvedExecutable: string | null;
  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    resolvedExecutable = cached.resolvedPath;
  } else {
    const found = yield* Effect.promise(async () => resolveExecutable(command, platform, env));
    resolvedExecutable =
      found === undefined
        ? null
        : yield* Effect.promise(() => preferGitForWindowsBinaryAsync(found, env));
    if (!explicitPath && resolvedExecutable !== null) {
      cacheCommandResolution(cache, cacheKey, resolvedExecutable, nowNanos);
    }
  }
  const resolvedCommand = resolvedExecutable ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }
  const shimExecutable = options.bypassNpmShim
    ? yield* Effect.promise(() => npmShimExecutableAsync(resolvedCommand))
    : undefined;
  if (shimExecutable !== undefined) {
    return { command: shimExecutable, args: [...args], shell: false };
  }

  // Build the escaped command line without separate args to avoid Node DEP0190 with shell:true.
  return {
    command: [resolvedCommand, ...args].map(escapeWindowsShellArg).join(" "),
    args: [],
    shell: true,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return (yield* resolveCommandPath(command, options)) !== null;
});

function resolveKnownWindowsCliDirs(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const appData = env.APPDATA?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const userProfile = env.USERPROFILE?.trim();

  return [
    ...(appData ? [`${appData}\\npm`] : []),
    ...(localAppData
      ? [
          `${localAppData}\\Programs\\nodejs`,
          `${localAppData}\\Volta\\bin`,
          `${localAppData}\\pnpm`,
        ]
      : []),
    ...(userProfile
      ? [`${userProfile}\\.local\\bin`, `${userProfile}\\.bun\\bin`, `${userProfile}\\scoop\\shims`]
      : []),
  ];
}

/** Keep one PATH spelling in copied Windows environment records. */
export function setWindowsPath(env: NodeJS.ProcessEnv, value: string | null): void {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH") {
      delete env[key];
    }
  }
  if (value !== null) env.PATH = value;
}

function mergeWindowsEnv(
  currentEnv: NodeJS.ProcessEnv,
  patch: Partial<Record<string, string>>,
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...currentEnv };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "PATH") {
      setWindowsPath(nextEnv, value);
    } else {
      nextEnv[key] = value;
    }
  }
  return nextEnv;
}

export const resolveWindowsEnvironment = Effect.fn("shell.resolveWindowsEnvironment")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Partial<NodeJS.ProcessEnv>, never, FileSystem.FileSystem | Path.Path> {
  const readEnvironment = yield* WindowsShellEnvironment;
  const commandAvailable = yield* CommandAvailability;
  const inheritedPath = readEnvPath(env);
  const shellPath = (yield* readEnvironment(["PATH"], { loadProfile: false })).PATH;
  const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(mergedPath, knownCliPath, "win32");
  const baselinePatch: Partial<NodeJS.ProcessEnv> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv = mergeWindowsEnv(env, baselinePatch);

  if (yield* commandAvailable("node", { env: baselineEnv })) {
    return baselinePatch;
  }

  const profiledEnvironment = yield* readEnvironment(["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"], {
    loadProfile: true,
  });
  const profiledPath = mergePathValues(profiledEnvironment.PATH, baselinePath, "win32");
  const profiledPatch: Partial<NodeJS.ProcessEnv> = {
    ...(profiledPath ? { PATH: profiledPath } : {}),
    ...(profiledEnvironment.FNM_DIR ? { FNM_DIR: profiledEnvironment.FNM_DIR } : {}),
    ...(profiledEnvironment.FNM_MULTISHELL_PATH
      ? { FNM_MULTISHELL_PATH: profiledEnvironment.FNM_MULTISHELL_PATH }
      : {}),
  };
  return Object.keys(profiledPatch).length > 0
    ? { ...baselinePatch, ...profiledPatch }
    : baselinePatch;
});

export function applyShellEnvironment(
  env: NodeJS.ProcessEnv,
  patch: ShellEnvironmentPatch,
  platform: NodeJS.Platform,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === "PATH" && platform === "win32") setWindowsPath(env, value);
    else if (value === null) delete env[key];
    else env[key] = value;
  }
}
