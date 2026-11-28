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
import { readIgnoreFile } from "./workspaceIgnoreFiles.ts";

const trimDirectorySeparator = (input: string) =>
  input.endsWith("/") ? input.slice(0, -1) : input;

const SYMLINK_SCAN_CONCURRENCY = 16;
// A scan no watcher can invalidate is reused this long, so typing does not rescan every folder.
const UNWATCHED_SYMLINK_SCAN_TTL_MS = 2_000;
// A rescan that outlasts this leaves the read on the previous scan.
const SYMLINK_RESCAN_WAIT = "5 millis";
// Small pages let searches run between the directory listing's native calls.
const SYMLINK_DIRECTORY_PAGE_SIZE = 1_000;

const MAX_DIRECTORIES = 4_096;
const MAX_DIRENTS = 50_000;
const MAX_LINKS = 4_096;
const MAX_PATH_BYTES = 4 * 1024 * 1024;
const MAX_IGNORE_BYTES = 256 * 1024;

function makeScanBudget() {
  let dirents = MAX_DIRENTS;
  let links = MAX_LINKS;
  let pathBytes = MAX_PATH_BYTES;
  let truncated = false;
  return {
    truncate: () => {
      truncated = true;
    },
    isTruncated: () => truncated,
    takePath: (path: string) => {
      pathBytes -= Buffer.byteLength(path);
      if (pathBytes >= 0) return true;
      truncated = true;
      return false;
    },
    takeDirent: (isLink: boolean) => {
      if (dirents > 0 && (!isLink || links > 0)) {
        dirents -= 1;
        if (isLink) links -= 1;
        return true;
      }
      truncated = true;
      return false;
    },
    canReadDirectory: () => dirents > 0 && pathBytes > 0,
  };
}

const joinEntryPath = (directory: string, name: string) =>
  directory ? `${directory}/${name}` : name;

function* ancestors(path: string) {
  let end = path.lastIndexOf("/");
  while (end > 0) {
    yield path.slice(0, end);
    end = path.lastIndexOf("/", end - 1);
  }
  yield "";
}

async function readDirectoryLinks(
  absolutePath: string,
  directory: string,
  budget: ReturnType<typeof makeScanBudget>,
) {
  const links: string[] = [];
  let isRepository = false;
  let hasIgnoreFile = false;
  let complete = false;
  if (!budget.canReadDirectory()) {
    budget.truncate();
  } else {
    try {
      // A watcher may have indexed a symlinked directory since the initial crawl.
      if ((await NodeFSP.realpath(absolutePath)) === absolutePath) {
        const dir = await NodeFSP.opendir(absolutePath);
        complete = true;
        for await (const child of dir) {
          const isLink = child.isSymbolicLink();
          const name = isLink ? joinEntryPath(directory, child.name) : child.name;
          if (!budget.takeDirent(isLink) || !budget.takePath(name)) {
            complete = false;
            break;
          }
          if (isLink) links.push(name);
          if (child.name === ".git") isRepository = true;
          if (child.name === ".ignore" && child.isFile()) hasIgnoreFile = true;
        }
      }
    } catch {
      complete = false;
    }
  }
  return { directory, links, isRepository, hasIgnoreFile, complete };
}

function decideByIgnoreFiles(entry: ProjectEntry, ignoreFiles: ReadonlyMap<string, IgnoreFile>) {
  for (const directory of ancestors(entry.path)) {
    const relative = directory ? entry.path.slice(directory.length + 1) : entry.path;
    // A link is never a folder to a folder-only rule, whatever it targets.
    const decision = ignoreFiles.get(directory)?.decide(relative, false);
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
    function* (budget: ReturnType<typeof makeScanBudget>) {
      const directories: string[] = [];
      // fff's pageIndex is an offset into the results, not a page number.
      for (let pageIndex = 0; pageIndex < MAX_DIRECTORIES;) {
        const pageSize = Math.min(SYMLINK_DIRECTORY_PAGE_SIZE, MAX_DIRECTORIES - pageIndex);
        const result = yield* Effect.promise(async () => {
          try {
            return await finder.directorySearchAsync("", {
              pageIndex,
              pageSize,
            });
          } catch {
            return undefined;
          }
        });
        if (!result?.ok) return directories;
        for (const item of result.value.items) {
          const directory = trimDirectorySeparator(input.toPosix(item.relativePath));
          if (path.isAbsolute(directory) || directory.split("/").includes("..")) continue;
          if (!budget.takePath(directory)) return directories;
          if (directory) directories.push(directory);
        }
        pageIndex += result.value.items.length;
        if (pageIndex >= result.value.totalMatched || result.value.items.length < pageSize) {
          return directories;
        }
      }
      budget.truncate();
      return directories;
    },
  );

  /** Ignore rules belong to the repository that owns a path, so each one answers for its own. */
  const listGitIgnored = Effect.fn("WorkspaceSearchIndex.listGitIgnored")(function* (
    repository: string,
    entries: ReadonlyArray<ProjectEntry>,
  ) {
    const relativePaths = entries.map(
      (entry) => `./${repository ? entry.path.slice(repository.length + 1) : entry.path}`,
    );
    const repositoryCwd = path.join(cwd, repository);
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceSearchIndex.listGitIgnored",
        command: "git",
        // fff applies ignore rules to tracked paths too, so the index is not consulted.
        // ./ avoids leading : pathspec magic; check-ignore rejects --literal-pathspecs.
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
      .map((ignoredPath) => {
        const relativePath = ignoredPath.replace(/^\.\//, "");
        return repository ? `${repository}/${relativePath}` : relativePath;
      });
  });

  const scanSymlinkEntries = Effect.fn("WorkspaceSearchIndex.scanSymlinkEntries")(function* () {
    const indexComplete = !(yield* input.isScanning);
    const budget = makeScanBudget();
    const directories = yield* listIndexedDirectories(budget);
    const scanned = yield* Effect.forEach(
      ["", ...directories],
      (directory) =>
        Effect.promise(() => readDirectoryLinks(path.join(root, directory), directory, budget)),
      { concurrency: SYMLINK_SCAN_CONCURRENCY },
    );
    const linkPaths = new Set(scanned.flatMap((directory) => directory.links));
    const coveredDirectories = new Set(
      scanned.filter((entry) => entry.complete).map((entry) => entry.directory),
    );
    const ignoreFiles = new Map<string, IgnoreFile>();
    const unavailableRules = new Set<string>();
    let ignoreBytes = MAX_IGNORE_BYTES;
    for (const entry of scanned) {
      if (!entry.complete || !entry.hasIgnoreFile) continue;
      const contents = yield* Effect.tryPromise(() =>
        readIgnoreFile(path.join(root, entry.directory, ".ignore"), ignoreBytes),
      ).pipe(Effect.orElseSucceed(() => "unavailable" as const));
      if (contents === "unavailable") {
        unavailableRules.add(entry.directory);
        budget.truncate();
      } else if (contents) {
        ignoreBytes -= contents.length;
        ignoreFiles.set(entry.directory, parseIgnoreFile(contents.toString()));
      }
    }
    const resultInfo = {
      linkPaths,
      indexComplete,
      coveredDirectories,
      truncated: budget.isTruncated(),
    };
    if (linkPaths.size === 0) return { entries: [], ...resultInfo };

    const candidateLinks = scanned.flatMap((directory) =>
      directory.complete ? directory.links : [],
    );
    const candidates = (yield* Effect.forEach(
      candidateLinks,
      (entryPath) =>
        Effect.gen(function* () {
          for (const parent of ancestors(entryPath)) {
            if (unavailableRules.has(parent) || !coveredDirectories.has(parent)) return undefined;
          }
          const absolutePath = path.join(root, entryPath);
          const target = yield* fileSystem.realPath(absolutePath).pipe(Effect.option);
          if (Option.isNone(target)) return undefined;
          const relative = path.relative(root, target.value);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative) ||
            relative.split(path.sep).includes(".git")
          )
            return undefined;
          const stat = yield* fileSystem.stat(target.value).pipe(Effect.option);
          if (
            Option.isNone(stat) ||
            (stat.value.type !== "Directory" && stat.value.type !== "File")
          ) {
            return undefined;
          }
          return {
            path: entryPath,
            kind: stat.value.type === "Directory" ? "directory" : "file",
          } satisfies ProjectEntry;
        }),
      { concurrency: SYMLINK_SCAN_CONCURRENCY },
    )).filter((entry) => entry !== undefined);
    const decisions = new Map<string, IgnoreDecision | undefined>(
      candidates.map((entry) => [entry.path, decideByIgnoreFiles(entry, ignoreFiles)]),
    );
    const repositories = new Set(
      scanned.filter((entry) => entry.isRepository).map((entry) => entry.directory),
    );
    const entriesByRepository = Map.groupBy(
      candidates.filter((entry) => decisions.get(entry.path) === undefined),
      (entry) => {
        for (const directory of ancestors(entry.path)) {
          if (repositories.has(directory)) return directory;
        }
        return "";
      },
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
      ...resultInfo,
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
      truncated: result.truncated,
      coveredDirectories: result.coveredDirectories,
    };
  });

  const filterIndexed = Effect.fn("WorkspaceSearchIndex.filterUnscannedSymlinks")(function* (
    entries: ReadonlyArray<ProjectEntry>,
    scan: Effect.Success<ReturnType<typeof listSymlinkEntries>>,
  ) {
    return yield* Effect.filter(
      entries,
      (entry) => {
        if (path.isAbsolute(entry.path) || entry.path.split("/").includes("..")) {
          return Effect.succeed(false);
        }
        const parent = entry.path.slice(0, Math.max(entry.path.lastIndexOf("/"), 0));
        if (scan.coveredDirectories.has(parent) || scan.linkPaths.has(entry.path))
          return Effect.succeed(true);
        const absolutePath = path.join(root, entry.path);
        return fileSystem.realPath(absolutePath).pipe(
          Effect.map((resolved) => resolved === absolutePath),
          Effect.orElseSucceed(() => false),
        );
      },
      { concurrency: SYMLINK_SCAN_CONCURRENCY },
    );
  });

  return { listSymlinkEntries, invalidateSymlinkScan, filterIndexed };
});
