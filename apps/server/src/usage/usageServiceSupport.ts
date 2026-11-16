import {
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type UsageProviderKind,
  type UsageSource,
  type ServerSettings as ServerSettingsValue,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import type { ProviderDriver } from "@goat/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import type {
  ProviderUsageInstance,
  TranscriptUsageFormat,
  UsageRecord,
} from "@goat/provider-core/server/usage";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { BUILT_IN_USAGE_DRIVERS } from "../provider/builtInDrivers.ts";
import { readTranscriptRecords } from "./usageTranscriptReader.ts";
import {
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";

const STALE_TEMP_DIRECTORY_MS = 60 * 60 * 1000;

export const transcriptReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "transcripts" ? [{ driver, reader: driver.usage }] : [],
);

export const scanReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "scan" ? [{ driver, reader: driver.usage }] : [],
);

export const transcriptFormats = new Map(
  transcriptReaders.map(({ reader }) => [reader.provider, reader.format] as const),
);

export interface TranscriptSource {
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly fileName?: string;
}

export const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
export const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
export const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

export const ScanCacheJson = Schema.fromJsonString(
  Schema.Unknown as unknown as Schema.Codec<unknown>,
);
export const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
export const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
export const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });

export function isLaterRead(a: CachedFile, b: CachedFile): boolean {
  return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);
}

export const sharedSessionProviders: ReadonlySet<UsageProviderKind> = new Set(
  transcriptReaders.flatMap(({ reader }) =>
    reader.format.sharedSessionsAcrossFiles ? [reader.provider] : [],
  ),
);

// Only shared sessions need cross-file dedupe; per-file occurrence counts make other keys unique.
export function sharedSessions(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (!sharedSessionProviders.has(provider) || sessionId === previous || sessionId.length === 0)
        continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}
export const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({
    sources: Schema.Record(Schema.String, CachedSource),
    coveredSince: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  }),
);

export interface ScannedDir {
  readonly provider: UsageProviderKind;
  readonly dir: string;
  readonly volumeId: string;
  readonly hostId?: string;
  readonly status?: UsageSource["status"];
  readonly message?: string;
  readonly action?: UsageSource["action"];
  readonly files:
    | readonly {
        readonly path: string;
        readonly records: readonly UsageRecord[];
        readonly malformedRecords: number;
      }[]
    | null;
  /** Every transcript path the walk listed, in walk order, whatever its mtime. */
  readonly walked?: readonly string[];
  readonly refreshing?: true;
}

export const resolveUsageHostId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const hostname = yield* HostProcess.Hostname;
  const hostIdPath = path.join(config.baseDir, "usage-host-id");
  const explicitHostId = hostEnvironment["GOAT_HOST_ID"]?.trim();
  const hostId =
    explicitHostId ||
    (yield* fileSystem.readFileString(hostIdPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* fileSystem.makeDirectory(config.baseDir, { recursive: true });
              const tempDirectory = yield* fileSystem.makeTempDirectoryScoped({
                directory: config.baseDir,
                prefix: "usage-host-id.",
              });
              const tempFile = path.join(tempDirectory, "identity");
              yield* fileSystem.writeFileString(tempFile, `${hostname}\n`);
              // Publish complete contents without replacing another initializer's identity.
              yield* fileSystem.link(tempFile, hostIdPath).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "AlreadyExists",
                  () => Effect.void,
                ),
              );
              return yield* fileSystem.readFileString(hostIdPath);
            }),
          ),
      ),
      Effect.map((value) => value.trim() || hostname),
      Effect.orElseSucceed(() => hostname),
    ));
  return hostId;
});

export function makeUsageInstances(hostEnvironment: NodeJS.ProcessEnv) {
  const usageInstances = Effect.fn("UsageService.usageInstances")(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: ServerSettingsValue,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    if (!Object.hasOwn(settings.providerInstances, driver.driverKind)) {
      entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    }
    const decodeConfig = Schema.decodeUnknownOption(driver.configSchema);
    return yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([instanceId, instance, configured]) {
        const instanceConfig: ProviderUsageInstance<Config> = {
          instanceId,
          config: Option.getOrUndefined(decodeConfig(instance.config ?? {})),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ),
          configured,
        };
        return instanceConfig;
      }),
    );
  });
  return usageInstances;
}

export function makeSupersededCacheRemover(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  config: { readonly stateDir: string },
) {
  // The saved cache supersedes older versions. Temp folders an aborted write left behind are
  // removed once idle for an hour, so a write in progress from another server survives.
  const removeSupersededCacheFiles = Effect.gen(function* () {
    for (const fileName of LEGACY_SCAN_CACHE_FILE_NAMES) {
      yield* fileSystem.remove(path.join(config.stateDir, fileName)).pipe(Effect.ignore);
    }
    const tempPrefixes = [SCAN_CACHE_FILE_NAME, ...LEGACY_SCAN_CACHE_FILE_NAMES].map(
      (fileName) => `${fileName}.`,
    );
    const staleBeforeMs = (yield* Clock.currentTimeMillis) - STALE_TEMP_DIRECTORY_MS;
    for (const name of yield* fileSystem.readDirectory(config.stateDir)) {
      if (!tempPrefixes.some((prefix) => name.startsWith(prefix))) continue;
      const tempPath = path.join(config.stateDir, name);
      yield* fileSystem.stat(tempPath).pipe(
        Effect.flatMap((info) => {
          const mtimeMs = Option.getOrUndefined(info.mtime)?.getTime();
          return info.type === "Directory" && mtimeMs !== undefined && mtimeMs <= staleBeforeMs
            ? fileSystem.remove(tempPath, { recursive: true })
            : Effect.void;
        }),
        Effect.ignore,
      );
    }
  }).pipe(Effect.ignore);
  return removeSupersededCacheFiles;
}

export function makeFileRecordReader(
  fileCache: ScanCache,
  resolvedRecords: WeakMap<UsageRecord, UsageRecord>,
  correctedRecord: (record: UsageRecord) => UsageRecord,
) {
  /**
   * Reads run concurrently, and the caller stores updates in walk order rather
   * than completion order: saved records of deleted transcripts aggregate in
   * cache order, where the first copy of a duplicate decides its bucket. Untraced: a scan
   * reads thousands of files, so scanTranscriptDir records the counts instead.
   */
  const readFileRecords = Effect.fnUntraced(function* (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
  ): Effect.fn.Return<{
    readonly records: readonly UsageRecord[];
    readonly malformedRecords: number;
    readonly failed?: true;
    readonly update?: { readonly entry: CachedFile; readonly replaces: CachedFile | undefined };
  }> {
    const cached = fileCache.get(filePath);
    // Provider is part of the identity: if both providers were ever pointed
    // at one directory, a hit parsed by the other parser must not be reused.
    if (
      cached &&
      cached.size === size &&
      cached.mtimeMs === mtimeMs &&
      cached.provider === provider
    ) {
      return {
        records:
          cached.tailRecords.length === 0
            ? cached.records
            : [...cached.records, ...cached.tailRecords],
        malformedRecords: cached.malformedRecords,
      };
    }

    // Only a strictly grown file may resume. Same size with a new mtime, or
    // a shrunken file, means rewritten content; re-parse it whole.
    const resumeFrom =
      cached !== undefined && cached.provider === provider && size > cached.size
        ? cached.position
        : undefined;

    const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, format, resumeFrom));
    // A read failure is not an empty transcript: caching it under this
    // (size, mtime) would silently drop the file's usage until it changes.
    if (parsed === null)
      return {
        records: cached?.provider === provider ? [...cached.records, ...cached.tailRecords] : [],
        malformedRecords: cached?.provider === provider ? cached.malformedRecords : 0,
        failed: true,
      };

    if (parsed.resumed && cached !== undefined && cached.tailRecords.length > 0) {
      // Completing a tentative line reparses it. Reuse its saved correction only when the
      // same usage is emitted again, without putting inferred tiers in the parser state.
      const reparsed = [...parsed.records, ...parsed.tailRecords];
      const identity = (record: UsageRecord) =>
        encodeUsageRecordKey([
          record.provider,
          record.sessionId,
          record.timestampMs,
          record.model,
          record.rateModel,
          record.totals,
          record.reportedCostUsd,
          record.dedupeKey,
        ]);
      for (const [index, previous] of cached.tailRecords.entries()) {
        const record = reparsed[index];
        const corrected = correctedRecord(previous);
        if (
          record?.unresolvedServiceTierTurnId !== undefined &&
          corrected.unresolvedServiceTierTurnId === undefined &&
          identity(record) === identity(corrected)
        ) {
          resolvedRecords.set(record, corrected);
        }
      }
    }
    const base = parsed.resumed && cached !== undefined ? cached.records : [];
    const records = dedupeWithinFile([...base, ...parsed.records]);
    const tailRecords = parsed.tailRecords;

    return {
      records: tailRecords.length === 0 ? records : [...records, ...tailRecords],
      malformedRecords: parsed.malformedRecords,
      update: {
        entry: {
          size,
          mtimeMs,
          provider,
          records,
          tailRecords,
          malformedRecords: parsed.malformedRecords,
          position: parsed.position,
        },
        replaces: cached,
      },
    };
  });
  return readFileRecords;
}
