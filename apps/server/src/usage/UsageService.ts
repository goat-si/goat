import {
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import { formatMalformedUsageWarning } from "@goat/shared/usageFormat";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import type { UsageHistoryPruneGuard, UsageRecord } from "@goat/provider-core/server/usage";
import {
  canonicalModelFilter,
  keepsUsageRecord,
  mapUsageModel,
  resolveModelAliases,
  UsageAggregator,
} from "./usageAggregation.ts";
import {
  createOverrideRateTable,
  parseRateTable,
  unlistedUsageRateModel,
  type RateTable,
} from "./usagePricing.ts";
import {
  DESKTOP_HOST_SCOPE_ENV,
  listTranscriptFiles,
  readDirectoryVolumeId,
  readPhysicalSourceId,
} from "./usageTranscriptReader.ts";
import { LEGACY_SCAN_CACHE_FILE_NAMES, SCAN_CACHE_FILE_NAME } from "./usageScanCache.ts";
import { UsageHistoryPages } from "./usageHistoryPages.ts";
import { InvalidUsageCache, loadScanCachePages } from "./usageCacheStream.ts";
import { dropArchivedOriginals } from "./usageArchiveCache.ts";
import {
  CachedSource,
  decodeCachedSources,
  decodeRatesCache,
  encodeRatesCache,
  encodeUsageRecordKey,
  isLaterRead,
  makeFileRecordReader,
  makeSupersededCacheRemover,
  makeUsageInstances,
  providerRateModel,
  resolveSourceOwners,
  resolveUsageHostId,
  type ScannedDir,
  scanReaders,
  sharedSessionProviders,
  sharedSessions,
  type TranscriptSource,
  transcriptFormats,
  transcriptReaders,
} from "./usageServiceSupport.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const LITELLM_RATES_API_URL =
  "https://api.github.com/repos/BerriAI/litellm/contents/model_prices_and_context_window.json?ref=main";

const MAX_CHECKED_RATE_MODELS = 512;
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

// mtime slack includes writes just before local midnight on the window's first day.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const TRANSCRIPT_READ_CONCURRENCY = 4;

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("goat/usage/UsageService") {}

export const make = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostPlatform = yield* HostProcess.Platform;
  const desktopHostScope = hostEnvironment[DESKTOP_HOST_SCOPE_ENV];
  const physicalSourceIdentity = (dir: string) =>
    Effect.promise(() => readPhysicalSourceId(dir, desktopHostScope, hostPlatform)).pipe(
      Effect.map((id) => (id === undefined ? {} : { physicalSourceId: id })),
    );
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();

  const fileCache = new UsageHistoryPages();
  // Reads from concurrent windows can still hold the original record after it is corrected.
  const resolvedRecords = new WeakMap<UsageRecord, UsageRecord>();
  const correctedRecord = (record: UsageRecord) => resolvedRecords.get(record) ?? record;
  const correctedBatch = (records: readonly UsageRecord[]) =>
    records.some((record) => resolvedRecords.has(record)) ? records.map(correctedRecord) : records;
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  // Earliest window start a complete scan read each transcript directory from.
  const coveredSince = new Map<string, number>();
  const coverageKey = (source: TranscriptSource) => `${source.provider}\0${source.dir}`;
  let cacheDirty = false;
  const cover = (source: TranscriptSource, windowStartMs: number) => {
    if ((coveredSince.get(coverageKey(source)) ?? Infinity) <= windowStartMs) return;
    coveredSince.set(coverageKey(source), windowStartMs);
    cacheDirty = true;
  };
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, SCAN_CACHE_FILE_NAME);
  const writeCacheFile = (filePath: string, contents: string | Iterable<string>) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const hostId = yield* resolveUsageHostId;
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesLastFailedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  const ratesLock = yield* Semaphore.make(1);
  const checkedRateModels = new Set<string>();

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  const fetchRates = (url: string, accept = "application/json") =>
    httpClient.get(url, { headers: { accept } }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.map((document) => {
        const parsed = parseRateTable(document);
        return parsed.size > 0 ? { document, parsed } : null;
      }),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  // Outside ratesLock, which a slow fetch holds: a provisional answer prices with these.
  const loadSavedRates = yield* Effect.cached(
    fileSystem.readFileString(ratesCachePath).pipe(
      Effect.flatMap((raw) => decodeRatesCache(raw)),
      Effect.map((saved) => {
        const parsed = parseRateTable(saved.document);
        if (parsed.size === 0) return;
        rates = parsed;
        ratesFetchedAtMs = saved.fetchedAtMs;
        ratesStatus = "cached";
      }),
      Effect.ignoreCause,
    ),
  );

  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    yield* loadSavedRates;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return false;
    if (ratesLastFailedAtMs !== null && now - ratesLastFailedAtMs < RATES_REFRESH_FLOOR_MS)
      return false;

    let fetched = yield* fetchRates(LITELLM_RATES_URL);
    if (fetched === null) {
      fetched = yield* fetchRates(LITELLM_RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (fetched === null) {
      ratesLastFailedAtMs = yield* Clock.currentTimeMillis;
      if (rates.size > 0) ratesStatus = "cached";
      return false;
    }

    checkedRateModels.clear();
    rates = fetched.parsed;
    ratesFetchedAtMs = now;
    ratesLastFailedAtMs = null;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched.document }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
    return true;
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  const refreshForUnlistedModels = Effect.fn("UsageService.refreshForUnlistedModels")(function* (
    models: ReadonlySet<string>,
  ) {
    if (models.size === 0) return;
    yield* ratesLock.withPermit(
      Effect.gen(function* () {
        if (![...models].some((model) => !checkedRateModels.has(model))) return;
        if (!(yield* loadRates(true))) return;
        for (const model of models) {
          const oldest = checkedRateModels.values().next().value;
          if (checkedRateModels.size >= MAX_CHECKED_RATE_MODELS && oldest !== undefined) {
            checkedRateModels.delete(oldest);
          }
          checkedRateModels.add(model);
        }
      }),
    );
  });

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  const usageInstances = makeUsageInstances(hostEnvironment);

  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
  ) {
    const dirs: Array<TranscriptSource> = [];
    const pending: Array<ScannedDir> = [];
    const seen = new Set<string>();
    for (const { driver, reader } of transcriptReaders) {
      const { provider, format } = reader;
      const directories = yield* Effect.forEach(
        yield* usageInstances(driver, settings),
        (instance) => reader.directories(instance, { awaitRefresh }),
      );
      for (const { dir: directory, fileName, refreshing } of directories.flat()) {
        if (refreshing) {
          const key = `${provider}\0${directory}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pending.push({ provider, dir: directory, volumeId: "", files: [], refreshing });
          continue;
        }
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const hasRetainedHistory = fileCache
          .metadata()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              (entry.records > 0 || entry.malformedRecords > 0) &&
              isWithinDirectory(filePath, dir),
          );
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          cacheDirty = true;
        }
        const key = `${provider}\0${dir}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dirs.push({
          provider,
          format,
          dir,
          volumeId,
          ...(fileName === undefined ? {} : { fileName }),
        });
      }
    }
    return { dirs, pending };
  });

  // Share first loads so concurrent readers cannot scan against a still-empty cache.
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const readDocument = (filePath: string) =>
        Effect.tryPromise({
          try: () => loadScanCachePages(filePath, fileCache, transcriptFormats),
          catch: (cause) =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Could not read the saved usage cache.",
              cause,
            }),
        }).pipe(
          Effect.catchIf(
            (error) => error.cause instanceof InvalidUsageCache,
            (cause) => Effect.logWarning(cause.detail, { cause }).pipe(Effect.as(null)),
          ),
        );
      let document = yield* readDocument(scanCachePath);
      const current = document !== null;
      for (const fileName of LEGACY_SCAN_CACHE_FILE_NAMES) {
        if (document !== null) break;
        document = yield* readDocument(path.join(config.stateDir, fileName));
        cacheDirty = document !== null;
      }
      if (document === null) return;
      const sources = decodeCachedSources(document.metadata);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
        if (current && document.complete && fileCache.size > 0) {
          for (const [key, since] of Object.entries(sources.value.coveredSince ?? {}))
            coveredSince.set(key, since);
        }
      }
    }),
  );

  // Serialize writes so concurrently finished window scans cannot overwrite newer snapshots.
  const persistLock = yield* Semaphore.make(1);

  let supersededFilesRemoved = false;
  const removeSupersededCacheFiles = makeSupersededCacheRemover(fileSystem, path, config);

  // Clear dirty before encoding to retain concurrent changes; restore it on failure for retry.
  const persistCaches = Effect.gen(function* () {
    if (cacheDirty) {
      cacheDirty = false;
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          fileCache.writeSnapshot({
            sources: Object.fromEntries(sourceCache),
            coveredSince: Object.fromEntries(coveredSince),
          }),
        ),
        (snapshot) => writeCacheFile(scanCachePath, snapshot.contents),
        (snapshot) => Effect.sync(snapshot.release),
      ).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (supersededFilesRemoved) return Effect.void;
            supersededFilesRemoved = true;
            return removeSupersededCacheFiles;
          }),
        ),
        Effect.catchCause(() =>
          Effect.sync(() => {
            cacheDirty = true;
          }),
        ),
      );
    }
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persistCaches).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() =>
    awaitPersisted.pipe(Effect.ensuring(Effect.sync(() => fileCache.close()))),
  );

  const readFileRecords = makeFileRecordReader(fileCache, resolvedRecords, correctedRecord);

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
    fromMemory: boolean,
  ) {
    const { provider, format, dir, volumeId, fileName } = source;
    const identity = { provider, dir, volumeId, ...(yield* physicalSourceIdentity(dir)) };
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) {
      cover(source, windowStartMs);
      return { ...identity, files: null } satisfies ScannedDir;
    }
    // scanSummary aggregates the saved files, as it does for a deleted directory.
    if (fromMemory) return { ...identity, files: [] } satisfies ScannedDir;
    const { files, walked, failedPaths } = yield* Effect.promise(() =>
      listTranscriptFiles(dir, windowStartMs, fileName === undefined ? undefined : { fileName }),
    );
    const read = yield* Effect.forEach(
      files,
      (file) =>
        readFileRecords(file.path, file.size, file.mtimeMs, provider, format).pipe(
          Effect.map((result) => ({ path: file.path, ...result })),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const parsedFiles = read.map(({ path, records, malformedRecords, update }) => {
      if (update === undefined) return { path, records, malformedRecords };
      // A scan of another window may have cached its own read of this file
      // meanwhile. Then keep whichever read saw the later file, so a slower
      // scan never replaces newer usage with older.
      const current = fileCache.get(path);
      if (
        current === update.replaces ||
        current === undefined ||
        isLaterRead(update.entry, current)
      ) {
        fileCache.set(path, {
          ...update.entry,
          records: correctedBatch(update.entry.records),
          tailRecords: correctedBatch(update.entry.tailRecords),
        });
        cacheDirty = true;
      }
      return { path, records, malformedRecords };
    });
    const livePaths = files.map((file) => file.path);
    if (dropArchivedOriginals(fileCache, livePaths, read)) cacheDirty = true;
    const unread = failedPaths + read.filter((file) => file.failed).length;
    if (unread === 0) cover(source, windowStartMs);
    yield* Effect.annotateCurrentSpan({
      "usage.files": files.length,
      "usage.files_parsed": read.filter((file) => file.update !== undefined).length,
    });
    return {
      ...identity,
      files: parsedFiles,
      walked,
      ...(unread > 0
        ? {
            status: "partial",
            message: `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    } satisfies ScannedDir;
  });

  const historyPruneGuard =
    (retention: ServerSettingsValue["usageHistoryRetentionDays"]): UsageHistoryPruneGuard =>
    (commit) =>
      settingsService
        .withSettingsSnapshot(
          (current) => commit(current.usageHistoryRetentionDays === retention),
          { refreshFromDisk: true },
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not read settings before pruning usage history.", {
              cause,
            }).pipe(Effect.andThen(commit(false))),
          ),
        );

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    { dirs, pending }: Effect.Success<ReturnType<typeof resolveTranscriptDirs>>,
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
    fromMemory: boolean,
  ) {
    const scans = Effect.forEach(
      scanReaders,
      ({ driver, reader }) =>
        usageInstances(driver, settings).pipe(
          Effect.flatMap((instances) =>
            reader.scan({
              instances,
              settings,
              windowStartMs,
              retentionCutoffMs,
              withHistoryPruneGuard: historyPruneGuard(settings.usageHistoryRetentionDays),
              awaitRefresh,
            }),
          ),
          Effect.flatMap((sources) =>
            Effect.forEach(sources, ({ volumeId, ...source }) =>
              Effect.map(
                volumeId === undefined
                  ? Effect.all({
                      volumeId: Effect.promise(() => readDirectoryVolumeId(source.dir)),
                      physical: physicalSourceIdentity(source.dir),
                    })
                  : Effect.succeed({ volumeId, physical: {} }),
                (identity): ScannedDir => ({
                  ...source,
                  files: source.files?.map((file) => ({ ...file, malformedRecords: 0 })) ?? null,
                  provider: reader.provider,
                  volumeId: identity.volumeId,
                  ...identity.physical,
                }),
              ),
            ),
          ),
          Effect.provideContext(readerContext),
        ),
      { concurrency: "unbounded" },
    );

    // Scan independent sources together, directories sequentially to bound open files; keep order, since the first copy decides a duplicate's bucket.
    const [transcripts, scanDirs] = yield* Effect.all(
      [Effect.forEach(dirs, (dir) => scanTranscriptDir(dir, windowStartMs, fromMemory)), scans],
      { concurrency: "unbounded" },
    );
    const scanned: readonly ScannedDir[] = [...transcripts, ...pending, ...scanDirs.flat()];
    return scanned;
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    provisional: boolean,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const retention = settings.usageHistoryRetentionDays;
    const retentionCutoffMs =
      retention === "unlimited" ? 0 : Math.max(0, startedAtMs - retention * 86400000);

    const awaitRefresh = input.awaitRefresh === true;
    const collect = Effect.gen(function* () {
      const resolved = yield* resolveTranscriptDirs(settings, retentionCutoffMs, awaitRefresh).pipe(
        Effect.provideContext(readerContext),
      );
      // A window no complete scan has read would show partial totals, so every directory must cover it.
      // Saved files are keyed by path, so two providers reading one directory keep only one parse.
      const fromMemory =
        provisional &&
        resolved.dirs.length > 0 &&
        new Set(resolved.dirs.map((source) => source.dir)).size === resolved.dirs.length &&
        resolved.dirs.every(
          (source) => (coveredSince.get(coverageKey(source)) ?? Infinity) <= windowStartMs,
        );
      const [, scanned] = yield* Effect.all(
        [
          fromMemory ? loadSavedRates : provisional ? ensureRates(false) : Effect.void,
          collectDirs(
            resolved,
            windowStartMs,
            settings,
            retentionCutoffMs,
            awaitRefresh,
            fromMemory,
          ),
        ],
        { concurrency: 2 },
      );
      return { scannedDirs: scanned, fromMemory };
    });
    const [{ scannedDirs, fromMemory }] = yield* Effect.all(
      [collect, provisional ? Effect.void : ensureRates(false)],
      { concurrency: 2 },
    );

    const priceOverrides = createOverrideRateTable(settings.usagePriceOverrides);
    const modelAliases = resolveModelAliases(settings.usageModelAliases);

    // Deleted transcripts' saved usage still aggregates and deduplicates normally.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    // Saved paths are files below a scanned root, so their folder decides; folders repeat thousands of times.
    const withinDir = (dir: string) => {
      const foldersWithin = new Map<string, boolean>();
      return (filePath: string) => {
        const folder = path.dirname(filePath);
        let within = foldersWithin.get(folder);
        if (within === undefined) {
          within = isWithinDirectory(folder, dir);
          foldersWithin.set(folder, within);
        }
        return within;
      };
    };
    const knownFiles = yield* Effect.acquireRelease(
      Effect.sync(() => fileCache.snapshot()),
      (snapshot) => Effect.sync(snapshot.release),
    );
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const liveFiles = files ?? [];
      const livePaths = new Set(liveFiles.map((file) => file.path));
      const isRetained = withinDir(dir);
      return {
        *[Symbol.iterator]() {
          yield* liveFiles;
          for (const [filePath, entry, version] of knownFiles.entries(
            (filePath, meta) =>
              meta.provider === provider &&
              meta.mtimeMs >= retainedSinceMs &&
              !livePaths.has(filePath) &&
              isRetained(filePath),
          )) {
            yield {
              path: filePath,
              historyPage: { entry, version },
              records:
                entry.tailRecords.length === 0
                  ? entry.records
                  : [...entry.records, ...entry.tailRecords],
              malformedRecords: entry.malformedRecords,
            };
          }
        },
      };
    });
    // Usage two transcripts share counts in the first one, so saved files take the order an exact
    // scan reads them in: walked files in walk order, then the directory's deleted files.
    for (const { provider, dir, walked } of fromMemory ? [] : scannedDirs) {
      if (walked === undefined) continue;
      const within = withinDir(dir);
      const saved = [...fileCache.metadata()];
      const slots = saved.flatMap(([filePath, entry], index) =>
        entry.provider === provider && within(filePath) ? [index] : [],
      );
      if (slots.length < 2) continue;
      const members = new Map(slots.flatMap((slot) => saved.slice(slot, slot + 1)));
      const listed = new Set(walked);
      const target = [
        ...walked.flatMap((filePath) => {
          const entry = members.get(filePath);
          return entry === undefined ? [] : [[filePath, entry] as const];
        }),
        ...[...members].filter(([filePath]) => !listed.has(filePath)),
      ];
      const ordered: Array<readonly [string, (typeof saved)[number][1]]> = [...saved];
      for (const [index, slot] of slots.entries()) {
        const member = target[index];
        if (member !== undefined) ordered[slot] = member;
      }
      if (ordered.every(([filePath], index) => filePath === saved[index]?.[0])) continue;
      fileCache.setOrder(ordered.map(([filePath]) => filePath));
      cacheDirty = true;
    }
    const windowEndMs =
      hourlyWindow?.untilTimeMs ??
      Date.parse(`${input.untilDay}T00:00:00Z`) + 86400000 + MTIME_SLACK_MS;
    if (!fromMemory) {
      const unlisted = new Set<string>();
      const mapping = { rates, modelAliases, rateModel: providerRateModel };
      scanModels: for (const files of filesByDir) {
        for (const file of files) {
          for (const record of file.records) {
            if (
              record.timestampMs < windowStartMs ||
              record.timestampMs >= windowEndMs ||
              !keepsUsageRecord(input.modelFilter, record)
            )
              continue;
            const model = unlistedUsageRateModel(
              rates,
              mapUsageModel(record, mapping),
              priceOverrides,
            );
            if (model === undefined || checkedRateModels.has(model)) continue;
            unlisted.add(model);
            if (unlisted.size >= MAX_CHECKED_RATE_MODELS) break scanModels;
          }
        }
      }
      yield* refreshForUnlistedModels(unlisted);
    }

    const summaryPricing = pricing();
    const contributions = fileCache.contributions();
    yield* Effect.addFinalizer(() => Effect.sync(contributions.clear));
    const aggregator = new UsageAggregator({
      contributions,
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides,
      modelAliases,
      rateModel: providerRateModel,
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    });

    const crossFileSessions = sharedSessions(Iterator.from(filesByDir).flatMap((files) => files));

    const scans = resolveSourceOwners(scannedDirs, filesByDir);
    const tierReaders = fromMemory ? [] : transcriptReaders.map(({ reader }) => reader);
    const counted = new Set<number>();
    const sessions = new Map<number, Set<string>>();
    for (const { source, files, ownerIndex } of scans) {
      const ownerPath = scannedDirs[ownerIndex]?.dir ?? source.dir;
      const resolveTiers = tierReaders.find(
        (reader) => reader.provider === source.provider,
      )?.resolveServiceTiers;
      for (const file of files) {
        if (resolveTiers !== undefined) {
          const version = file.historyPage?.version ?? fileCache.version(file.path);
          const saved = file.historyPage?.entry ?? fileCache.get(file.path);
          const resolve = (pending: readonly UsageRecord[]) =>
            resolveTiers(pending).pipe(
              Effect.provideContext(readerContext),
              Effect.map((resolved) => {
                for (const [record, speed] of resolved) {
                  const { unresolvedServiceTierTurnId: _turnId, ...rest } = record;
                  resolvedRecords.set(record, { ...rest, speed });
                }
              }),
            );
          let pending: UsageRecord[] = [];
          for (const raw of file.records) {
            const record = correctedRecord(raw);
            if (
              record.unresolvedServiceTierTurnId === undefined ||
              record.timestampMs < windowStartMs ||
              record.timestampMs >= windowEndMs
            )
              continue;
            pending.push(record);
            if (pending.length === 256) {
              yield* resolve(pending);
              pending = [];
            }
          }
          if (pending.length > 0) yield* resolve(pending);
          if (saved !== undefined && fileCache.version(file.path) === version) {
            const records = correctedBatch(saved.records);
            const tailRecords = correctedBatch(saved.tailRecords);
            if (records !== saved.records || tailRecords !== saved.tailRecords) {
              fileCache.set(file.path, { ...saved, records, tailRecords });
              cacheDirty = true;
            }
          }
        }
        const eventOccurrences = new Map<string, number>();
        for (const rawRecord of file.records) {
          const record = correctedRecord(rawRecord);
          let usageRecord = record;
          if (
            sharedSessionProviders.has(record.provider) &&
            crossFileSessions.has(record.sessionId)
          ) {
            // Dedupe moved copies but retain repeated equal events within a file, including second-precision timestamps.
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (eventOccurrences.get(key) ?? 0) + 1;
            eventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          if (!aggregator.add(usageRecord, ownerPath)) continue;
          counted.add(ownerIndex);
          if (record.sessionId.length > 0) {
            const ids = sessions.get(ownerIndex) ?? new Set<string>();
            ids.add(record.sessionId);
            sessions.set(ownerIndex, ids);
          }
        }
      }
    }

    const sources = scans.map(
      ({ source, status, scannedFiles, skippedFiles, malformedRecords }, index): UsageSource => {
        const {
          provider,
          dir,
          volumeId,
          physicalSourceId,
          action,
          refreshing,
          hostId: sourceHostId,
        } = source;
        const sourceMessage =
          source.message ??
          (source.files === null ? "No transcript directory on this environment." : null);
        return {
          fingerprint: {
            hostId: sourceHostId ?? hostId,
            provider,
            resolvedHomePath: dir,
            volumeId,
            ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
          },
          status,
          scannedFiles,
          skippedFiles,
          malformedRecords,
          distinctSessions: sessions.get(index)?.size ?? 0,
          message:
            malformedRecords > 0
              ? [sourceMessage, formatMalformedUsageWarning(malformedRecords)]
                  .filter(Boolean)
                  .join(" ")
              : sourceMessage,
          ...(action ? { action } : {}),
          ...(refreshing || (fromMemory && counted.has(index) && transcriptFormats.has(provider))
            ? { refreshing: true }
            : {}),
        };
      },
    );

    if (fileCache.metadata().some(([, entry]) => entry.mtimeMs < retentionCutoffMs)) {
      yield* historyPruneGuard(retention)((authorized) =>
        Effect.sync(() => {
          if (!authorized) return;
          for (const [filePath, entry] of fileCache.metadata()) {
            if (entry.mtimeMs < retentionCutoffMs) fileCache.delete(filePath);
          }
          cacheDirty = true;
          for (const [key, since] of coveredSince) {
            if (since < retentionCutoffMs) coveredSince.set(key, retentionCutoffMs);
          }
        }),
      );
    }

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    const summary = {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: summaryPricing,
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    } satisfies UsageSummary;
    return { summary, fromMemory };
  }, Effect.scoped);

  const readWindow = Effect.fn("UsageService.readWindow")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    provisional: boolean,
  ) {
    const { summary, fromMemory } = yield* scanSummary(input, settings, provisional);
    // With nothing marked refreshing the client would keep a saved answer as final.
    return fromMemory && !summary.sources.some((source) => source.refreshing === true)
      ? (yield* scanSummary(input, settings, false)).summary
      : summary;
  });

  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
    provisional: boolean,
  ): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings,
      input.awaitRefresh === true,
      provisional,
      input.modelFilter ?? null,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (
    requested: UsageSummaryInput,
  ) {
    const { modelFilter: requestedFilter, ...unfiltered } = requested;
    const modelFilter = canonicalModelFilter(requestedFilter);
    const input = modelFilter === undefined ? unfiltered : { ...unfiltered, modelFilter };
    const settings = yield* readSettings;
    const provisional = input.provisional === true && input.awaitRefresh !== true;
    const key = scanKey(input, settings, provisional);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Register and fork atomically so cancellation cannot leave a Deferred without a scan.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detach so caller departure cannot cancel shared scans; finished scans warm the cache.
        // Register writes before releasing waiters, but start writing after delivering their summary.
        yield* readWindow(input, settings, provisional).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(Exit.isSuccess(exit) ? schedulePersist : Effect.void),
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkIn(serviceScope),
        );
        return created;
      }),
    );
    return yield* Deferred.await(deferred);
  });

  return { readSummary, refreshRates, awaitPersisted } as const;
});

export const layer = Layer.effect(UsageService, make);
