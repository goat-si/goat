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
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@goat/shared/atomicWrite";
import { formatMalformedUsageWarning } from "@goat/shared/usageFormat";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import type { UsageRecord } from "@goat/provider-core/server/usage";
import { canonicalModelFilter, resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import { createOverrideRateTable, parseRateTable, type RateTable } from "./usagePricing.ts";
import { listTranscriptFiles, readDirectoryVolumeId } from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type ScanCache,
} from "./usageScanCache.ts";
import { dropArchivedOriginals } from "./usageArchiveCache.ts";
import {
  CachedSource,
  decodeCachedSources,
  decodeRatesCache,
  decodeScanCacheFile,
  encodeRatesCache,
  encodeUsageRecordKey,
  isLaterRead,
  makeFileRecordReader,
  makeSupersededCacheRemover,
  makeUsageInstances,
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

const RATES_TTL_MS = 24 * 60 * 60 * 1000;

const RATES_REFRESH_FLOOR_MS = 60 * 1000;

// mtime slack includes writes just before local midnight on the window's first day.
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const CACHE_RETENTION_DAYS = 92;

const TRANSCRIPT_READ_CONCURRENCY = 4;

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("goat/usage/UsageService") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const hostEnvironment = yield* HostProcess.Environment;
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();

  const fileCache: ScanCache = new Map();
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
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;
    if (ratesLastFailedAtMs !== null && now - ratesLastFailedAtMs < RATES_REFRESH_FLOOR_MS) return;

    let fetched = yield* fetchRates(LITELLM_RATES_URL);
    if (fetched === null) {
      fetched = yield* fetchRates(LITELLM_RATES_API_URL, "application/vnd.github.raw+json");
    }
    if (fetched === null) {
      ratesLastFailedAtMs = yield* Clock.currentTimeMillis;
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    rates = fetched.parsed;
    ratesFetchedAtMs = now;
    ratesLastFailedAtMs = null;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched.document }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

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
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              (entry.records.length + entry.tailRecords.length > 0 || entry.malformedRecords > 0) &&
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
        fileSystem.readFileString(filePath).pipe(
          Effect.flatMap((raw) => decodeScanCacheFile(raw)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
      let document = yield* readDocument(scanCachePath);
      const current = document !== null;
      for (const fileName of LEGACY_SCAN_CACHE_FILE_NAMES) {
        if (document !== null) break;
        document = yield* readDocument(path.join(config.stateDir, fileName));
        cacheDirty = document !== null;
      }
      if (document === null) return;
      const decoded = decodeScanCache(document, transcriptFormats);
      for (const [path, entry] of decoded) fileCache.set(path, entry);
      const saved = (document as { readonly files?: unknown }).files;
      const complete =
        typeof saved === "object" && saved !== null && Object.keys(saved).length === decoded.size;
      const sources = decodeCachedSources(document);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
        // Coverage describes the saved files, so it needs every one, in this version's format.
        if (current && complete && fileCache.size > 0) {
          for (const [key, since] of Object.entries(sources.value.coveredSince ?? {}))
            coveredSince.set(key, since);
        }
      }
    }),
  );

  const writeScanCache = makeScanCacheWriter();
  // Serialize writes so concurrently finished window scans cannot overwrite newer snapshots.
  const persistLock = yield* Semaphore.make(1);

  let supersededFilesRemoved = false;
  const removeSupersededCacheFiles = makeSupersededCacheRemover(fileSystem, path, config);

  // Clear dirty before encoding to retain concurrent changes; restore it on failure for retry.
  const persistCaches = Effect.gen(function* () {
    if (cacheDirty) {
      cacheDirty = false;
      yield* Effect.sync(() =>
        writeScanCache(fileCache, {
          sources: Object.fromEntries(sourceCache),
          coveredSince: Object.fromEntries(coveredSince),
        }),
      ).pipe(
        Effect.flatMap((contents) => writeCacheFile(scanCachePath, contents)),
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
  yield* Effect.addFinalizer(() => awaitPersisted);

  const readFileRecords = makeFileRecordReader(fileCache, resolvedRecords, correctedRecord);

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
    fromMemory: boolean,
  ) {
    const { provider, format, dir, volumeId, fileName } = source;
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) {
      cover(source, windowStartMs);
      return { provider, dir, volumeId, files: null } satisfies ScannedDir;
    }
    // scanSummary aggregates the saved files, as it does for a deleted directory.
    if (fromMemory) return { provider, dir, volumeId, files: [] } satisfies ScannedDir;
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
      provider,
      dir,
      volumeId,
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
            reader.scan({ instances, settings, windowStartMs, retentionCutoffMs, awaitRefresh }),
          ),
          Effect.flatMap((sources) =>
            Effect.forEach(sources, ({ volumeId, ...source }) =>
              Effect.map(
                volumeId === undefined
                  ? Effect.promise(() => readDirectoryVolumeId(source.dir))
                  : Effect.succeed(volumeId),
                (resolved): ScannedDir => ({
                  ...source,
                  files: source.files?.map((file) => ({ ...file, malformedRecords: 0 })) ?? null,
                  provider: reader.provider,
                  volumeId: resolved,
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

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      modelAliases: resolveModelAliases(settings.usageModelAliases),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    });

    const sources: UsageSource[] = [];

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
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      const isRetained = withinDir(dir);
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
          livePaths.has(filePath) ||
          !isRetained(filePath)
        )
          continue;
        retainedFiles.push({
          path: filePath,
          records:
            entry.tailRecords.length === 0
              ? entry.records
              : [...entry.records, ...entry.tailRecords],
          malformedRecords: entry.malformedRecords,
        });
      }
      return retainedFiles;
    });
    // Usage two transcripts share counts in the first one, so saved files take the order an exact
    // scan reads them in: walked files in walk order, then the directory's deleted files.
    for (const { provider, dir, walked } of fromMemory ? [] : scannedDirs) {
      if (walked === undefined) continue;
      const within = withinDir(dir);
      const saved = [...fileCache];
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
      fileCache.clear();
      for (const [filePath, entry] of ordered) fileCache.set(filePath, entry);
      cacheDirty = true;
    }
    const windowEndMs =
      hourlyWindow?.untilTimeMs ??
      Date.parse(`${input.untilDay}T00:00:00Z`) + 86400000 + MTIME_SLACK_MS;
    let resolvedAny = false;
    for (const { reader } of transcriptReaders) {
      if (reader.resolveServiceTiers === undefined || fromMemory) continue;
      const pending = new Set<UsageRecord>();
      for (const [index, files] of filesByDir.entries()) {
        if (scannedDirs[index]?.provider !== reader.provider) continue;
        for (const file of files) {
          for (const raw of file.records) {
            const record = correctedRecord(raw);
            if (
              record.provider === reader.provider &&
              record.unresolvedServiceTierTurnId !== undefined &&
              record.timestampMs >= windowStartMs &&
              record.timestampMs < windowEndMs
            ) {
              pending.add(record);
            }
          }
        }
      }
      if (pending.size === 0) continue;
      const resolved = yield* reader
        .resolveServiceTiers([...pending])
        .pipe(Effect.provideContext(readerContext));
      for (const [record, speed] of resolved) {
        const { unresolvedServiceTierTurnId: _turnId, ...rest } = record;
        resolvedRecords.set(record, { ...rest, speed });
        resolvedAny = true;
      }
    }
    if (resolvedAny) {
      for (const [filePath, entry] of fileCache) {
        const records = correctedBatch(entry.records);
        const tailRecords = correctedBatch(entry.tailRecords);
        if (records === entry.records && tailRecords === entry.tailRecords) continue;
        // Update the current entry by identity; a slow resolver cannot restore an older file.
        fileCache.set(filePath, { ...entry, records, tailRecords });
        cacheDirty = true;
      }
    }
    const crossFileSessions = sharedSessions(filesByDir.flat());

    for (const [
      index,
      { provider, dir, volumeId, files, status, message, action, refreshing, hostId: sourceHostId },
    ] of scannedDirs.entries()) {
      let scannedFiles = 0;
      let skippedFiles = 0;
      let malformedRecords = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      let counted = false;

      for (const file of filesByDir[index] ?? []) {
        malformedRecords += file.malformedRecords;
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
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
          if (aggregator.add(usageRecord, dir)) {
            counted = true;
            if (record.sessionId.length > 0) sessionIds.add(record.sessionId);
          }
        }
      }

      const sourceMessage =
        message ?? (files === null ? "No transcript directory on this environment." : null);
      sources.push({
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        status:
          files === null && scannedFiles === 0
            ? "missing"
            : malformedRecords > 0
              ? status === undefined || status === "ok"
                ? "partial"
                : status
              : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords,
        distinctSessions: sessionIds.size,
        message:
          malformedRecords > 0
            ? [sourceMessage, formatMalformedUsageWarning(malformedRecords)]
                .filter(Boolean)
                .join(" ")
            : sourceMessage,
        ...(action ? { action } : {}),
        // A saved answer misses what changed since its scan, so the client must ask again. An
        // empty source stays unmarked: it would only flash a loading row.
        ...(refreshing || (fromMemory && counted && transcriptFormats.has(provider))
          ? { refreshing: true }
          : {}),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) {
      cacheDirty = true;
      // Pruned files are no longer saved, so nothing before the cutoff stays covered.
      for (const [key, since] of coveredSince) {
        if (since < retentionCutoffMs) coveredSince.set(key, retentionCutoffMs);
      }
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
      pricing: pricing(),
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
      ...(input.modelFilter === undefined ? {} : { modelFilter: input.modelFilter }),
    } satisfies UsageSummary;
    return { summary, fromMemory };
  });

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
          Effect.forkDetach,
        );
        return created;
      }),
    );
    return yield* Deferred.await(deferred);
  });

  return { readSummary, refreshRates, awaitPersisted } as const;
});

export const layer = Layer.effect(UsageService, make);
