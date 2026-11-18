// @effect-diagnostics nodeBuiltinImport:off - readdir with file types avoids an lstat per child
import * as NodeFSP from "node:fs/promises";

import type { FileFinder as FileFinderType, WatchEvent, WatchUnsubscribe } from "@ff-labs/fff-node";
import type { ProjectEntry, ProjectSearchEntriesResult } from "@goat/contracts";
import { scoreSubsequenceMatch } from "@goat/shared/searchRanking";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { type IgnoreDecision, type IgnoreFile, parseIgnoreFile } from "./IgnorePatterns.ts";

const trimDirectorySeparator = (input: string) =>
  input.endsWith("/") ? input.slice(0, -1) : input;

const SYMLINK_SCAN_CONCURRENCY = 16;
// A scan no watcher can invalidate is reused this long, so typing does not rescan every folder.
const UNWATCHED_SYMLINK_SCAN_TTL_MS = 2_000;
// A rescan that outlasts this leaves the read on the previous scan.
const SYMLINK_RESCAN_WAIT = "5 millis";
// Small pages let searches run between the directory listing's native calls.
const SYMLINK_DIRECTORY_PAGE_SIZE = 1_000;

interface ScannedDirectory {
  readonly directory: string;
  readonly links: ReadonlyArray<ProjectEntry>;
  /** Every symlink in the folder, including ones dropped for leaving the workspace. */
  readonly linkPaths: ReadonlyArray<string>;
  /** A nested repository (or the workspace's own), whose ignore rules own what is below it. */
  readonly isRepository: boolean;
  readonly ignoreFile: string | undefined;
}

const joinEntryPath = (directory: string, name: string) =>
  directory ? `${directory}/${name}` : name;

/**
 * fff skips symlinks, and `followSymlinks` drops file links, dedupes folder links, and walks out
 * of the workspace. So links are read from the folders fff already indexed (ignore rules applied),
 * without descending into them, and kept only when they resolve inside the workspace.
 */
const scanDirectory = Effect.fn("WorkspaceSearchIndex.scanDirectory")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  root: string,
  directory: string,
) {
  // Effect's readDirectory returns bare names; one lstat per child would cost far more.
  const children = yield* Effect.promise(() =>
    NodeFSP.readdir(path.join(cwd, directory), { withFileTypes: true }).catch(() => []),
  );
  const links: ProjectEntry[] = [];
  const linkPaths: string[] = [];
  let isRepository = false;
  let ignoreFile: string | undefined;
  for (const child of children) {
    if (child.name === ".git") isRepository = true;
    if (child.name === ".ignore" && child.isFile()) {
      ignoreFile = yield* fileSystem
        .readFileString(path.join(cwd, directory, child.name))
        .pipe(Effect.orElseSucceed(() => undefined));
    }
    if (!child.isSymbolicLink()) continue;
    const entryPath = joinEntryPath(directory, child.name);
    linkPaths.push(entryPath);
    const absolutePath = path.join(cwd, entryPath);
    const target = yield* Effect.all([
      fileSystem.realPath(absolutePath),
      fileSystem.stat(absolutePath),
    ]).pipe(Effect.orElseSucceed(() => undefined));
    if (!target) continue;
    const relative = path.relative(root, target[0]);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes(".git") ||
      (target[1].type !== "Directory" && target[1].type !== "File")
    ) {
      continue;
    }
    links.push({ path: entryPath, kind: target[1].type === "Directory" ? "directory" : "file" });
  }
  return { directory, links, linkPaths, isRepository, ignoreFile } satisfies ScannedDirectory;
});

/** Whether `entryPath` is `directory` itself or below it. */
const isWithin = (entryPath: string, directory: string) =>
  directory === "" || entryPath.startsWith(`${directory}/`);

/**
 * fff reads `.ignore` files alongside git's rules, and like ripgrep the nearest one that matches
 * decides, ahead of any `.gitignore`. `ignoreFiles` is ordered deepest folder first.
 */
function decideByIgnoreFiles(
  entry: ProjectEntry,
  ignoreFiles: ReadonlyArray<{ readonly directory: string; readonly file: IgnoreFile }>,
): IgnoreDecision | undefined {
  for (const { directory, file } of ignoreFiles) {
    if (!isWithin(entry.path, directory) || entry.path === directory) continue;
    const relative = directory ? entry.path.slice(directory.length + 1) : entry.path;
    // Like git and ripgrep, a link is never a folder to a folder-only rule, whatever it targets.
    const decision = file.decide(relative, false);
    if (decision) return decision;
  }
  return undefined;
}

/** Places each symlink before the first index result that matches the query less closely. */
export function mergeSymlinkMatches(
  indexed: ProjectSearchEntriesResult,
  linkPaths: ReadonlySet<string>,
  symlinks: ReadonlyArray<ProjectEntry>,
  query: string,
  limit: number,
): ProjectSearchEntriesResult {
  if (linkPaths.size === 0) return indexed;
  // fff's watcher indexes links created after its scan, under a kind of its own choosing, so a
  // path it already returned takes the link's kind (or drops out of a kind-filtered search).
  const symlinkByPath = new Map(symlinks.map((entry) => [entry.path, entry]));
  const score = (entry: ProjectEntry) =>
    scoreSubsequenceMatch(entry.path.toLowerCase(), query) ?? Number.POSITIVE_INFINITY;
  const indexedPaths = new Set(indexed.entries.map((entry) => entry.path));
  const pending = symlinks
    .flatMap((entry) => {
      const entryScore = score(entry);
      return Number.isFinite(entryScore) && !indexedPaths.has(entry.path)
        ? [{ entry, score: entryScore }]
        : [];
    })
    .toSorted((left, right) => left.score - right.score);
  const entries: ProjectEntry[] = [];
  let nextPending = 0;
  for (const indexedEntry of indexed.entries) {
    const entry = linkPaths.has(indexedEntry.path)
      ? symlinkByPath.get(indexedEntry.path)
      : indexedEntry;
    if (!entry) continue;
    const entryScore = score(entry);
    for (let next = pending[nextPending]; next !== undefined && next.score < entryScore;) {
      entries.push(next.entry);
      next = pending[++nextPending];
    }
    entries.push(entry);
  }
  entries.push(...pending.slice(nextPending).map((next) => next.entry));
  return {
    entries: entries.slice(0, limit),
    truncated: indexed.truncated || entries.length > limit,
  };
}

/**
 * The symlinks a workspace search lists, rescanned when fff's watcher reports a change. Reads
 * share one scan at a time; see listSymlinkEntries.
 */
export const makeSymlinkScan = Effect.fn("WorkspaceSearchIndex.makeSymlinkScan")(function* (input: {
  readonly finder: FileFinderType;
  readonly cwd: string;
  readonly isScanning: Effect.Effect<boolean>;
  /** A host relative path in the index's POSIX form. */
  readonly toPosix: (relativePath: string) => string;
  /** Whether Git's ignore rules hide this path, as they hide indexed files. */
  readonly isIgnored: (relativePath: string) => boolean;
}) {
  const { finder, cwd } = input;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const root = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));

  const listIndexedDirectories = Effect.fn("WorkspaceSearchIndex.listIndexedDirectories")(
    function* () {
      const directories: string[] = [];
      // fff's pageIndex is an offset into the results, not a page number.
      for (let pageIndex = 0; ; pageIndex += SYMLINK_DIRECTORY_PAGE_SIZE) {
        const result = yield* Effect.promise(async () => {
          try {
            return await finder.directorySearchAsync("", {
              pageIndex,
              pageSize: SYMLINK_DIRECTORY_PAGE_SIZE,
            });
          } catch {
            return undefined;
          }
        });
        if (!result?.ok) return directories;
        for (const item of result.value.items) {
          const directory = trimDirectorySeparator(input.toPosix(item.relativePath));
          if (directory) directories.push(directory);
        }
        if (result.value.items.length < SYMLINK_DIRECTORY_PAGE_SIZE) return directories;
      }
    },
  );

  /** Ignore rules belong to the repository that owns a path, so each one answers for its own. */
  const listGitIgnored = Effect.fn("WorkspaceSearchIndex.listGitIgnored")(function* (
    repository: string,
    entries: ReadonlyArray<ProjectEntry>,
  ) {
    const relativePaths = entries.map((entry) =>
      repository ? entry.path.slice(repository.length + 1) : entry.path,
    );
    const repositoryCwd = path.join(cwd, repository);
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceSearchIndex.listGitIgnored",
        command: "git",
        // fff applies ignore rules to tracked paths too, so the index is not consulted.
        args: ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin"],
        cwd: repositoryCwd,
        stdin: `${relativePaths.join("\0")}\0`,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    // Exit 1 means nothing matched.
    if (result?.exitCode === 1) return [];
    if (result?.exitCode !== 0 || result.stdoutTruncated) {
      // Outside git no rules apply (git exits before reading stdin, so the cause is lost).
      // Any other failure hides the repository's links rather than leaking ones it ignores.
      const insideRepository = yield* vcsProcess
        .run({
          operation: "WorkspaceSearchIndex.listGitIgnored",
          command: "git",
          args: ["rev-parse", "--git-dir"],
          cwd: repositoryCwd,
          timeoutMs: 10_000,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      return insideRepository ? entries.map((entry) => entry.path) : [];
    }
    return result.stdout
      .split("\0")
      .filter(Boolean)
      .map((relativePath) => (repository ? `${repository}/${relativePath}` : relativePath));
  });

  const scanSymlinkEntries = Effect.fn("WorkspaceSearchIndex.scanSymlinkEntries")(function* () {
    const indexComplete = !(yield* input.isScanning);
    const directories = yield* listIndexedDirectories();
    const scanned = yield* Effect.forEach(
      ["", ...directories],
      (directory) => scanDirectory(fileSystem, path, cwd, root, directory),
      { concurrency: SYMLINK_SCAN_CONCURRENCY },
    );
    const candidates = scanned.flatMap((directory) => directory.links);
    const linkPaths = new Set(scanned.flatMap((directory) => directory.linkPaths));
    if (candidates.length === 0) return { entries: candidates, linkPaths, indexComplete };

    const ignoreFiles = scanned
      .flatMap(({ directory, ignoreFile }) =>
        ignoreFile === undefined ? [] : [{ directory, file: parseIgnoreFile(ignoreFile) }],
      )
      .toSorted((left, right) => right.directory.length - left.directory.length);
    const decisions = new Map(
      candidates.map((entry) => [entry.path, decideByIgnoreFiles(entry, ignoreFiles)]),
    );
    const repositories = [
      "",
      ...scanned.flatMap(({ directory, isRepository }) =>
        isRepository && directory ? [directory] : [],
      ),
    ].toSorted((left, right) => right.length - left.length);
    const entriesByRepository = Map.groupBy(
      candidates.filter((entry) => decisions.get(entry.path) === undefined),
      (entry) =>
        repositories.find(
          (repository) => isWithin(entry.path, repository) && entry.path !== repository,
        ) ?? "",
    );
    const ignored = new Set(
      (yield* Effect.forEach(
        entriesByRepository,
        ([repository, entries]) => listGitIgnored(repository, entries),
        { concurrency: 4 },
      )).flat(),
    );
    return {
      entries: candidates.filter((entry) =>
        decisions.get(entry.path) === undefined
          ? !ignored.has(entry.path)
          : decisions.get(entry.path) === "included",
      ),
      linkPaths,
      indexComplete,
    };
  });

  // One scan runs at a time and outlives the reads that started it. Only the first read waits for
  // it in full: after that a change or expiry marks the result stale, and reads wait briefly for
  // the rescan before answering from the last finished one, so file churn cannot stall search.
  type SymlinkScan = Effect.Success<ReturnType<typeof scanSymlinkEntries>>;
  let lastSymlinkScan: SymlinkScan | undefined;
  let lastSymlinkScanExpiresAt: number | undefined;
  let pendingSymlinkScan: Deferred.Deferred<SymlinkScan> | undefined;
  let symlinkScanStale = false;
  let knownLinkPaths: ReadonlySet<string> = new Set();
  const invalidateSymlinkScan = () => {
    symlinkScanStale = true;
  };
  const isKnownLink = (absolutePath: string) =>
    [cwd, root].some((base) =>
      knownLinkPaths.has(input.toPosix(path.relative(base, absolutePath))),
    );
  const onWatchBatch = (events: ReadonlyArray<WatchEvent>) => {
    // fff reports a link replaced in place as `modified`, so edits to known links count too.
    const editsOnly = events.every(
      (event) =>
        event.kind === "modified" &&
        !/(^|[\\/])\.(git)?ignore$/.test(event.path) &&
        !isKnownLink(event.path),
    );
    if (!editsOnly) invalidateSymlinkScan();
  };
  // fff refuses subscriptions until its watcher is up, which can trail the initial scan, so
  // each read retries until one is in place. Subscribing waits on fff's picker lock, which its
  // watcher holds while it indexes a new folder, so it runs off the JS thread.
  let unwatch: WatchUnsubscribe | undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => unwatch?.()));
  const ensureWatching = Effect.fn("WorkspaceSearchIndex.ensureWatching")(function* () {
    if (unwatch) return true;
    // A throw before the promise exists counts as a failed subscription too.
    const result = yield* Effect.tryPromise(() => finder.watchAsync(onWatchBatch)).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (result?.ok) unwatch = result.value;
    return unwatch !== undefined;
  });
  const indexScope = yield* Effect.scope;
  const startSymlinkScan = Effect.fn("WorkspaceSearchIndex.startSymlinkScan")(function* () {
    symlinkScanStale = false;
    const done = yield* Deferred.make<SymlinkScan>();
    pendingSymlinkScan = done;
    yield* Effect.gen(function* () {
      // Subscribing before the scan starts means no change during it goes unseen.
      const watched = yield* ensureWatching();
      const result = yield* scanSymlinkEntries();
      lastSymlinkScan = result;
      knownLinkPaths = result.linkPaths;
      // Without a watcher, or before fff has seen every folder, the result is kept only briefly.
      lastSymlinkScanExpiresAt =
        watched && result.indexComplete
          ? undefined
          : (yield* Clock.currentTimeMillis) + UNWATCHED_SYMLINK_SCAN_TTL_MS;
      return result;
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          pendingSymlinkScan = undefined;
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
      Effect.forkIn(indexScope),
    );
    return done;
  });
  const listSymlinkEntries = Effect.fn("WorkspaceSearchIndex.listSymlinkEntries")(function* () {
    if (
      lastSymlinkScanExpiresAt !== undefined &&
      (yield* Clock.currentTimeMillis) >= lastSymlinkScanExpiresAt
    ) {
      symlinkScanStale = true;
    }
    const pending =
      pendingSymlinkScan ??
      (lastSymlinkScan === undefined || symlinkScanStale ? yield* startSymlinkScan() : undefined);
    let result = lastSymlinkScan;
    if (pending && result === undefined) {
      result = yield* Deferred.await(pending);
    } else if (pending) {
      const fresh = yield* Deferred.await(pending).pipe(Effect.timeoutOption(SYMLINK_RESCAN_WAIT));
      if (Option.isSome(fresh)) result = fresh.value;
    }
    if (result === undefined)
      return yield* Effect.die("The symlink scan finished without a result.");
    return {
      // Git's ignore rules hide a link the same way searchVisible hides the files it indexes.
      entries: result.entries.filter((entry) => !input.isIgnored(entry.path)),
      linkPaths: result.linkPaths,
    };
  });

  return { listSymlinkEntries, invalidateSymlinkScan };
});
