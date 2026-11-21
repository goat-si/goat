// @effect-diagnostics nodeBuiltinImport:off - normalize paths without adding services to the search index layer.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type {
  DirItem,
  FileItem,
  FileFinder as FileFinderType,
  GrepCursor,
  MixedItem,
  Result,
} from "@ff-labs/fff-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@goat/contracts";
import { PROJECT_FAVICON_EXTENSIONS, isProjectFaviconPath } from "@goat/shared/projectFavicon";
import * as HostProcess from "@goat/shared/HostProcess";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { isNonRepositoryGitStderr } from "../vcs/gitNonRepository.ts";
import { isWholeWordRange, mapContentMatchRanges } from "./workspaceContentMatchRanges.ts";
import { searchContentsWithGit } from "./workspaceGitContentSearch.ts";
import { makeIgnoreFileDecider } from "./workspaceIgnoreFiles.ts";
import { makeSymlinkScan, mergeSymlinkMatches } from "./workspaceSymlinkScan.ts";

// fff-node's native library stays external; single-executables require disk packages instead of importing them.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

// A glob intersects existing extension constraints; fff ORs bare `*.ext` constraints together.
const IMAGE_SEARCH_CONSTRAINT = `**/*.{${PROJECT_FAVICON_EXTENSIONS.map((extension) =>
  extension.slice(1).replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`),
).join(",")}}`;

// fff 0.11 disables filename fallback above this match count per base/overflow segment.
const FFF_FILENAME_FALLBACK_MAX_MATCHES = 15_000;

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedError<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedError<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace search index for '${this.cwd}' did not finish scanning within ${this.timeout}`;
  }
}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedError<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace search failed for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedError<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to refresh the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedError<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to destroy the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
      imageOnly?: boolean,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly searchContents: (
      input: Omit<ProjectSearchContentsInput, "cwd">,
    ) => Effect.Effect<
      ProjectSearchContentsResult,
      WorkspaceSearchIndexScanTimedOut | WorkspaceSearchIndexSearchFailed
    >;
    readonly refresh: () => Effect.Effect<void, WorkspaceSearchIndexRefreshFailed>;
  }
>()("goat/workspace/WorkspaceSearchIndex") {}

// Only the host separator becomes `/`: on POSIX `\` is a file name character.
function toPosixPath(input: string, hostIsWindows: boolean): string {
  return hostIsWindows ? input.replaceAll("\\", "/") : input;
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem, hostIsWindows: boolean): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath, hostIsWindows));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem, hostIsWindows: boolean): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath, hostIsWindows));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem, hostIsWindows: boolean): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath, hostIsWindows));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

function isLoneFuzzyPath(query: string): boolean {
  const trimmed = query.trim();
  return (
    !/\s/u.test(trimmed) &&
    (trimmed.startsWith("/") || (trimmed.endsWith("/") && !/^[*!\\]/u.test(trimmed)))
  );
}

type SearchPage<I> = { readonly items: ReadonlyArray<I>; readonly totalMatched: number };

function mapFileSearchResult(
  result: SearchPage<FileItem>,
  limit: number,
  hostIsWindows: boolean,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item, hostIsWindows);
    return entry && (!imageOnly || isProjectFaviconPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: SearchPage<DirItem>,
  limit: number,
  hostIsWindows: boolean,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item, hostIsWindows);
    return entry ? [entry] : [];
  });
  const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function mapMixedSearchResult(
  result: SearchPage<MixedItem>,
  limit: number,
  hostIsWindows: boolean,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item, hostIsWindows);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= limit) {
      break;
    }
  }

  const rootDirectoryCount = result.items.some(
    (item) => item.type === "directory" && item.item.relativePath.length === 0,
  )
    ? 1
    : 0;
  return {
    entries,
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function buildContentSearchQuery(input: Omit<ProjectSearchContentsInput, "cwd">): {
  readonly searchQuery: string;
  readonly regexMode: boolean;
} {
  if (input.caseSensitive) {
    return { searchQuery: input.query, regexMode: input.useRegex };
  }
  return input.useRegex
    ? { searchQuery: `(?i)${input.query}`, regexMode: true }
    : { searchQuery: input.query.toLowerCase(), regexMode: false };
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    let parentPath = parentPathOf(entry.path);
    while (parentPath) {
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentPathOf(parentPath);
    }
  }
  return [...entryByPath.values()];
}

// Git also lists exclusions from .git/info/exclude and the global excludes file.
const loadGitIgnoredPaths = Effect.fn("WorkspaceSearchIndex.listGitIgnoredPaths")(function* (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  cwd: string,
  hostIsWindows: boolean,
) {
  const ignored = new Set<string>();
  const reincluded: string[] = [];
  const paths = { ignored, reincluded };
  const result = yield* vcsProcess
    .run({
      operation: "WorkspaceSearchIndex.listGitIgnoredPaths",
      command: "git",
      args: [
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      cwd,
      env: { LC_ALL: "C", LANG: "C" },
      allowNonZeroExit: true,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not list Git ignored paths; continuing without them.",
          { cwd },
          cause,
        ).pipe(Effect.as(null)),
      ),
    );
  if (result === null) return paths;
  if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    if (result.exitCode === 0 || !isNonRepositoryGitStderr(result.stderr)) {
      yield* Effect.logWarning("Could not list Git ignored paths; continuing without them.", {
        cwd,
        exitCode: result.exitCode,
      });
    }
    return paths;
  }
  const decide = makeIgnoreFileDecider(cwd);
  for (const entry of result.stdout.split("\0")) {
    if (entry === "") continue;
    const relative = toPosixPath(entry, hostIsWindows);
    const path = trimDirectorySeparator(relative);
    if ((yield* decide(path, relative.endsWith("/"))) === "included") reincluded.push(relative);
    else ignored.add(path);
  }
  return paths;
});

function mixedItemPath(item: MixedItem): string {
  return item.item.relativePath;
}

function isIgnoredPath(
  ignoredPaths: ReadonlySet<string>,
  relativePath: string,
  hostIsWindows: boolean,
): boolean {
  if (ignoredPaths.size === 0) return false;
  let candidate: string | undefined = trimDirectorySeparator(
    toPosixPath(relativePath, hostIsWindows),
  );
  while (candidate) {
    if (ignoredPaths.has(candidate)) return true;
    candidate = parentPathOf(candidate);
  }
  return false;
}

const createFinder = Effect.fn("WorkspaceSearchIndex.createFinder")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant,
) {
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const normalize = (value: string) =>
    platform === "win32" ? NodePath.resolve(value).toLowerCase() : NodePath.resolve(value);
  if (normalize(cwd) === normalize(home)) {
    return yield* new WorkspaceSearchIndexCreateFailed({
      cwd,
      reason: "The home directory cannot be indexed as a workspace.",
    });
  }
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        // Content indexing costs CPU/memory; path-only consumers use the lightweight index.
        disableContentIndexing: variant !== "content",
        aiMode: false,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.create threw unexpectedly.",
        cause,
      }),
  });
  if (result.ok) return result.value;
  return yield* new WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  });
});

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: FileFinderType,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
): Effect.fn.Return<void, E | WorkspaceSearchIndexScanTimedOut> {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) =>
      onFailure({
        reason: "FileFinder.waitForIndexReady rejected unexpectedly.",
        cause,
      }),
  });
  if (!result.ok) {
    return yield* Effect.fail(onFailure({ reason: result.error }));
  }
  if (!result.value) {
    return yield* new WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant = "paths",
  onDestroyFailure: Effect.Effect<void> = Effect.void,
) {
  const hostIsWindows = yield* HostProcess.isWindows;
  const finder = yield* Effect.acquireRelease(createFinder(cwd, variant), (finder) =>
    Effect.tryPromise({
      try: () => finder.destroyAsync(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.catch((cause) => Effect.andThen(onDestroyFailure, Effect.die(cause)))),
  );
  let initialScanTimedOut = false;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  let gitIgnore = yield* loadGitIgnoredPaths(vcsProcess, cwd, hostIsWindows);
  if (variant === "paths") {
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexCreateFailed({
          cwd,
          reason,
          cause,
        }),
    ).pipe(
      Effect.catchTags({
        WorkspaceSearchIndexScanTimedOut: () =>
          Effect.sync(() => {
            initialScanTimedOut = true;
          }),
      }),
    );
  }
  let contentIndexPending = variant === "content";

  // fff's isScanning takes the picker lock too, so progress is read off the JS thread.
  const isScanning = Effect.promise(async () => {
    try {
      const progress = await finder.getScanProgressAsync();
      return !progress.ok || progress.value.isScanning;
    } catch {
      return true;
    }
  });
  const hasIncompleteInitialScan = () => (initialScanTimedOut ? isScanning : Effect.succeed(false));

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Promise<Result<A>>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexSearchFailed> {
    // fff's searches wait on its picker lock, which its watcher can hold for minutes.
    const result = yield* Effect.tryPromise({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} rejected unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  const { listSymlinkEntries, invalidateSymlinkScan, filterIndexed } = yield* makeSymlinkScan({
    finder,
    cwd,
    isScanning,
    toPosix: (relativePath) => toPosixPath(relativePath, hostIsWindows),
    isIgnored: (relativePath) => isIgnoredPath(gitIgnore.ignored, relativePath, hostIsWindows),
  });

  // Grows the first page until hidden entries can no longer crowd visible ones out of it.
  const searchVisible = Effect.fn("WorkspaceSearchIndex.searchVisible")(function* <I, Metadata>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "mixedSearch",
    execute: (pageSize: number) => Promise<Result<SearchPage<I> & Metadata>>,
    pathOf: (item: I) => string,
  ): Effect.fn.Return<SearchPage<I> & Metadata, WorkspaceSearchIndexSearchFailed> {
    let size = pageSize;
    while (true) {
      const fetchSize = size;
      const result = yield* runSearch(query, fetchSize, operation, () => execute(fetchSize));
      const ignoredPaths = gitIgnore.ignored;
      if (ignoredPaths.size === 0) return result;
      const items = result.items.filter(
        (item) => !isIgnoredPath(ignoredPaths, pathOf(item), hostIsWindows),
      );
      if (
        items.length >= pageSize ||
        result.items.length >= result.totalMatched ||
        fetchSize >= WORKSPACE_INDEX_PAGE_SIZE
      ) {
        return {
          ...result,
          items,
          totalMatched: result.totalMatched - (result.items.length - items.length),
        };
      }
      size = Math.min(WORKSPACE_INDEX_PAGE_SIZE, fetchSize * 4);
    }
  });

  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(function* () {
    // scanFiles waits on fff's picker lock, which its watcher can hold for seconds.
    const result = yield* Effect.tryPromise({
      try: () => finder.scanFilesAsync(),
      catch: (cause) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: "FileFinder.scanFilesAsync rejected unexpectedly.",
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexRefreshFailed({
        cwd,
        reason: result.error,
      });
    }
    // A rescan that outlasts the wait keeps running, and the finder answers
    // from its previous index until it finishes, so the index stays usable.
    yield* waitForIndexReady(
      cwd,
      finder,
      ({ reason, cause }) =>
        new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason,
          cause,
        }),
    ).pipe(Effect.catchTags({ WorkspaceSearchIndexScanTimedOut: () => Effect.void }));
    gitIgnore = yield* loadGitIgnoredPaths(vcsProcess, cwd, hostIsWindows);
    invalidateSymlinkScan();
  });

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const incompleteBeforeQuery = yield* hasIncompleteInitialScan();
      const result = yield* searchVisible(
        "",
        WORKSPACE_INDEX_PAGE_SIZE,
        "mixedSearch",
        (pageSize) => finder.mixedSearchAsync("", { pageSize }),
        mixedItemPath,
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES, hostIsWindows);
      const symlinks = yield* listSymlinkEntries();
      // fff's watcher can index a link the scan rejected; only accepted links are listed.
      const indexed = (yield* filterIndexed(mapped.entries, symlinks)).filter(
        (entry) => !symlinks.linkPaths.has(entry.path),
      );
      const sortedEntries = withDirectoryAncestors([...indexed, ...symlinks.entries]).toSorted(
        (left, right) => left.path.localeCompare(right.path),
      );
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
      return {
        entries,
        truncated:
          incompleteBeforeQuery ||
          mapped.truncated ||
          symlinks.truncated ||
          entries.length < sortedEntries.length,
      };
    },
  );

  const searchNames = Effect.fn("WorkspaceSearchIndex.searchNames")(function* (
    query: string,
    limit: number,
    kind: ProjectEntryKind | undefined,
    imageOnly: boolean | undefined,
  ) {
    const scan = yield* listSymlinkEntries();
    const { linkPaths } = scan;
    const symlinks = scan.entries.filter((entry) =>
      imageOnly
        ? entry.kind === "file" && isProjectFaviconPath(entry.path)
        : kind === undefined || entry.kind === kind,
    );
    // Index results that are filtered-out links get dropped in the merge, so fetch past them.
    const indexLimit = limit + linkPaths.size - symlinks.length;
    const pageSize = Math.max(1, indexLimit + 1);
    const merge = (indexed: ProjectSearchEntriesResult) =>
      filterIndexed(indexed.entries, scan).pipe(
        Effect.map((entries) =>
          mergeSymlinkMatches(
            { entries, truncated: indexed.truncated || scan.truncated },
            linkPaths,
            symlinks,
            query,
            limit,
          ),
        ),
      );
    if (kind === "file" || imageOnly) {
      const searchFiles = (fileQuery: string, size: number) =>
        searchVisible(
          query,
          size,
          "fileSearch",
          (fetchSize) => finder.fileSearchAsync(fileQuery, { pageSize: fetchSize }),
          (item: FileItem) => item.relativePath,
        );
      // Adding a constraint changes fff's lone-path parse; offset pages can skip tied matches.
      if (imageOnly && isLoneFuzzyPath(query)) {
        const result = yield* searchFiles(query, WORKSPACE_INDEX_PAGE_SIZE);
        return yield* merge(mapFileSearchResult(result, indexLimit, hostIsWindows, true));
      }
      let result = yield* searchFiles(
        imageOnly ? `${query} ${IMAGE_SEARCH_CONSTRAINT}` : query,
        pageSize,
      );
      if (
        imageOnly &&
        query.trim() &&
        result.totalFiles > FFF_FILENAME_FALLBACK_MAX_MATCHES &&
        result.totalMatched > 0
      ) {
        const unfiltered = yield* runSearch(query, 1, "fileSearch", () =>
          finder.fileSearchAsync(query, { pageSize: 1 }),
        );
        if (unfiltered.totalMatched > FFF_FILENAME_FALLBACK_MAX_MATCHES) {
          result = yield* searchFiles(query, WORKSPACE_INDEX_PAGE_SIZE);
        }
      }
      return yield* merge(mapFileSearchResult(result, indexLimit, hostIsWindows, imageOnly));
    }
    if (kind === "directory") {
      const result = yield* searchVisible(
        query,
        pageSize,
        "directorySearch",
        (size) => finder.directorySearchAsync(query, { pageSize: size }),
        (item) => item.relativePath,
      );
      return yield* merge(mapDirectorySearchResult(result, indexLimit, hostIsWindows));
    }
    const result = yield* searchVisible(
      query,
      pageSize,
      "mixedSearch",
      (size) => finder.mixedSearchAsync(query, { pageSize: size }),
      mixedItemPath,
    );
    return yield* merge(mapMixedSearchResult(result, indexLimit, hostIsWindows));
  });

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (rawQuery, limit, kind, imageOnly) {
    // fff parses any word containing "[" or "{" as a glob and has no escape for them; fuzzy
    // matching is subsequence-based, so dropping them still matches "[id]" and "a{b}" paths.
    // "{" is dropped only when the query finds nothing as a glob, so "*.{ts,tsx}" keeps working.
    const query = rawQuery.replaceAll("[", "");
    const incompleteBeforeQuery = yield* hasIncompleteInitialScan();
    let mapped = yield* searchNames(query, limit, kind, imageOnly);
    if (mapped.entries.length === 0 && query.includes("{")) {
      mapped = yield* searchNames(query.replaceAll("{", ""), limit, kind, imageOnly);
    }
    return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
  });

  const searchContents: WorkspaceSearchIndex["Service"]["searchContents"] = Effect.fn(
    "WorkspaceSearchIndex.searchContents",
  )(function* (input) {
    if (contentIndexPending) {
      const progress = yield* Effect.tryPromise(() => finder.getScanProgressAsync()).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (!progress?.ok || progress.value.isScanning || !progress.value.isWarmupComplete) {
        const fallback = yield* searchContentsWithGit(vcsProcess, cwd, input, gitIgnore.reincluded);
        if (fallback !== undefined) return fallback;
        yield* waitForIndexReady(
          cwd,
          finder,
          ({ reason, cause }) =>
            new WorkspaceSearchIndexSearchFailed({
              cwd,
              queryLength: input.query.length,
              pageSize: input.limit,
              reason,
              cause,
            }),
        );
      }
      contentIndexPending = false;
    }
    let { searchQuery, regexMode } = buildContentSearchQuery(input);
    const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
    // Grep cursors advance per file; whole-word filtering needs enough raw candidates before advancing.
    const rawPageSize = input.wholeWord
      ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE)
      : input.limit;
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    let nextCursor: GrepCursor | null = null;
    let regexFallbackError: string | undefined;
    let retryLiterally = false;

    do {
      const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const result = yield* runSearch(input.query, input.limit, "grep", () =>
        finder.grepAsync(searchQuery, {
          mode: regexMode ? "regex" : "plain",
          smartCase: !input.caseSensitive && !regexMode,
          maxMatchesPerFile: Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, rawPageSize),
          pageSize: rawPageSize,
          cursor: nextCursor,
          timeBudgetMs: remainingTimeBudgetMs,
        }),
      );
      // fff searches an invalid pattern as a literal, which would keep the `(?i)` prefix.
      retryLiterally = regexMode && !input.caseSensitive && result.regexFallbackError !== undefined;
      if (retryLiterally) {
        regexFallbackError = result.regexFallbackError;
        ({ searchQuery, regexMode } = buildContentSearchQuery({ ...input, useRegex: false }));
        continue;
      }

      for (const match of result.items) {
        if (isIgnoredPath(gitIgnore.ignored, match.relativePath, hostIsWindows)) continue;
        const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter(
          (range) => !input.wholeWord || isWholeWordRange(match.lineContent, range),
        );
        // fff reports hits past its 512-char lineContent cap with no ranges, so whole words can't be verified there.
        if (input.wholeWord && matchRanges.length === 0) continue;
        matches.push({
          path: toPosixPath(match.relativePath, hostIsWindows),
          lineNumber: match.lineNumber,
          lineContent: match.lineContent,
          matchRanges,
        });
      }
      nextCursor = result.nextCursor;
      regexFallbackError ??= result.regexFallbackError;
    } while (
      retryLiterally ||
      (matches.length < input.limit && nextCursor !== null && performance.now() < deadline)
    );

    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || nextCursor !== null,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  });

  return WorkspaceSearchIndex.of({ list, refresh, search, searchContents });
});

export const WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"] as const;
export type WorkspaceSearchIndexVariant = (typeof WORKSPACE_SEARCH_INDEX_VARIANTS)[number];
