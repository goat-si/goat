import {
  HostMaintenanceError,
  type DatabaseStorageStatus,
  type HostStorageCompactionResult,
  type HostStorageHealth,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveHostCliCommand } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ThreadHistoryArchive from "../orchestration-v2/ThreadHistoryArchive.ts";
import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";

/** Pages returned per reclaim pass; one minute of churn, not a backlog. */
const RECLAIM_PAGES_PER_PASS = 1024;
const COMPACTION_INTERVAL = Duration.hours(6);
/**
 * Measuring the memory tables walks their pages, so it reuses a recent figure; the rest of the
 * accounting is PRAGMA reads and stays fresh every minute.
 */
const MEMORY_MEASURE_INTERVAL_MS = 10 * 60_000;

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
    /** Current file accounting, re-published after each maintenance pass. Null until first read. */
    readonly status: Stream.Stream<DatabaseStorageStatus | null>;
    /** Memory versus history, for host status. Null until the first pass. */
    readonly health: Effect.Effect<HostStorageHealth | null>;
    /** Runs the scheduled history compaction now. A call while one runs waits for that run. */
    readonly compactNow: Effect.Effect<HostStorageHealth, HostMaintenanceError>;
  }
>()("goat/persistence/DatabaseStorage") {}

/**
 * Deletes superseded history every few hours and hands freed pages back to
 * the filesystem every minute. Deleted events are always superseded by a
 * retained event with a higher sequence, so a client replaying from an older
 * cursor still reaches the same state; no replay boundary is published.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const archive = yield* ThreadHistoryArchive.ThreadHistoryArchive;
  const settings = yield* Settings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const statusRef = yield* SubscriptionRef.make<DatabaseStorageStatus | null>(null);
  const healthRef = yield* Ref.make<HostStorageHealth | null>(null);
  const memoryMeasure = yield* Ref.make<{ readonly at: number; readonly bytes: number | null }>({
    at: Number.NEGATIVE_INFINITY,
    bytes: null,
  });
  const compaction = yield* Ref.make<{
    readonly since: string | null;
    readonly last: HostStorageCompactionResult | null;
    readonly running: Deferred.Deferred<HostStorageHealth, HostMaintenanceError> | null;
  }>({ since: null, last: null, running: null });

  // The notice shows this verbatim; quote for the host's shell. Desktop
  // installs have no `t3` on PATH, so the command names their launcher.
  const { command: compactCommand } = yield* resolveHostCliCommand("doctor", [
    "--base-dir",
    config.baseDir,
  ]);
  // `t3 doctor --base-dir` repairs <baseDir>/userdata. A dev server without
  // an explicit home keeps its state in <baseDir>/dev instead, so there the
  // command would target the live install; publish no status at all.
  const doctorTargetsThisDatabase =
    path.resolve(config.dbPath) ===
    path.resolve(config.baseDir, "userdata", path.basename(config.dbPath));
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Only memory_* objects (tables, their indexes, FTS shadow tables), one name at a time: dbstat
  // narrows to a name only on equality, and an unfiltered scan walks the whole database.
  const measureMemoryBytes = Effect.gen(function* () {
    const names = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE tbl_name LIKE 'memory!_%' ESCAPE '!'
    `;
    let bytes = 0;
    for (const { name } of names) {
      const rows = yield* sql<{ readonly bytes: number | null }>`
        SELECT sum(pgsize) AS bytes FROM dbstat WHERE name = ${name} AND aggregate = TRUE
      `;
      bytes += rows[0]?.bytes ?? 0;
      yield* Effect.yieldNow;
    }
    return bytes;
  }).pipe(Effect.orElseSucceed(() => null));

  const readHealth = Effect.gen(function* () {
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const pageSize = size[0]?.page_size ?? 0;
    const databaseBytes = (pages[0]?.page_count ?? 0) * pageSize;
    const reclaimableBytes = (free[0]?.freelist_count ?? 0) * pageSize;
    const now = yield* Clock.currentTimeMillis;
    let memory = yield* Ref.get(memoryMeasure);
    if (now - memory.at >= MEMORY_MEASURE_INTERVAL_MS) {
      memory = { at: now, bytes: yield* measureMemoryBytes };
      yield* Ref.set(memoryMeasure, memory);
    }
    const { since, last } = yield* Ref.get(compaction);
    const health: HostStorageHealth = {
      databaseBytes,
      memoryBytes: memory.bytes,
      historyBytes: Math.max(0, databaseBytes - reclaimableBytes - (memory.bytes ?? 0)),
      reclaimableBytes,
      measuredAt: yield* nowIso,
      ...(since === null ? {} : { compactingSince: since }),
      ...(last === null ? {} : { lastCompaction: last }),
    };
    yield* Ref.set(healthRef, health);
    return health;
  });

  const publishStatus = Effect.gen(function* () {
    yield* readHealth;
    if (!doctorTargetsThisDatabase) return;
    const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    const pageSize = size[0]?.page_size ?? 0;
    const archived = yield* archive.stats;
    const next: DatabaseStorageStatus = {
      databaseBytes: (pages[0]?.page_count ?? 0) * pageSize,
      reclaimableBytes: (free[0]?.freelist_count ?? 0) * pageSize,
      incrementalVacuumEnabled: mode[0]?.auto_vacuum === 2,
      compactCommand,
      archivedThreads: archived.threads,
      archiveBytes: archived.fileBytes,
    };
    // Every set reaches each open Storage page; most passes change nothing.
    if (!Equal.equals(yield* SubscriptionRef.get(statusRef), next)) {
      yield* SubscriptionRef.set(statusRef, next);
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database storage inspection failed", { cause })),
  );

  const reclaim = Effect.gen(function* () {
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum !== 2) return;
    // The driver steps a statement without result columns once, and each
    // step of incremental_vacuum frees one page. Yield between pages so
    // client requests can run.
    for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page++) {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      if ((free[0]?.freelist_count ?? 0) === 0) break;
      yield* sql`PRAGMA incremental_vacuum(1)`;
      yield* Effect.yieldNow;
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );

  // Even a pass that deletes nothing scans the event store. Persist completion
  // so restarting does not trigger another scan before the six-hour interval.
  const compactedAtPath = path.join(path.dirname(config.dbPath), "compacted-at");
  const runCompaction = Effect.gen(function* () {
    const before = yield* readHealth;
    yield* Ref.update(compaction, (state) => ({ ...state, since: before.measuredAt }));
    yield* readHealth;
    const result = yield* maintenance.compactEventStore;
    const { storageCleanup } = yield* settings.getSettings;
    // Archiving whole idle threads first leaves trimming only what is still over budget.
    const archived = yield* archive.runPass({
      archiveAfterDays: storageCleanup.historyArchiveAfterDays,
      deleteAfterDays: storageCleanup.historyArchiveDeleteAfterDays,
      now: yield* Clock.currentTimeMillis,
    });
    if (archived.archivedThreads > 0 || archived.deletedArchives > 0) {
      yield* Effect.logInfo("Archived idle thread history", archived);
    }
    const history = yield* maintenance.boundHistory({
      budgetBytes: storageCleanup.historyBudgetBytes,
      now: yield* Clock.currentTimeMillis,
    });
    const completedAt = yield* Clock.currentTimeMillis;
    yield* fs.writeFileString(compactedAtPath, String(completedAt)).pipe(Effect.ignore);
    if (result.deletedEventCount > 0 || result.deletedReceiptCount > 0) {
      yield* Effect.logInfo("Compacted orchestration history", result);
    }
    if (history.trimmedRows > 0) {
      yield* Effect.logInfo("Bounded orchestration history", {
        ...history,
        budgetBytes: storageCleanup.historyBudgetBytes,
      });
    }
    yield* reclaim;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    const after = yield* readHealth;
    const last: HostStorageCompactionResult = {
      finishedAt: after.measuredAt,
      removedEvents: result.deletedEventCount,
      freedBytes: Math.max(0, before.databaseBytes - after.databaseBytes),
      needsOfflineCompaction: mode[0]?.auto_vacuum !== 2 && after.reclaimableBytes > 0,
    };
    yield* Ref.update(compaction, (state) => ({ ...state, last }));
  }).pipe(
    Effect.ensuring(Ref.update(compaction, (state) => ({ ...state, since: null }))),
    Effect.andThen(publishStatus),
    Effect.andThen(Ref.get(healthRef)),
    Effect.flatMap((health) =>
      health === null
        ? Effect.fail(new HostMaintenanceError({ operation: "compact_storage", message: "" }))
        : Effect.succeed(health),
    ),
    Effect.mapError(
      (cause) =>
        new HostMaintenanceError({
          operation: "compact_storage",
          message:
            "Could not compact this machine's history" +
            (cause instanceof Error && cause.message.length > 0 ? ": " + cause.message : "."),
        }),
    ),
  );

  const compactNow = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const fresh = yield* Deferred.make<HostStorageHealth, HostMaintenanceError>();
      const joined = yield* Ref.modify(compaction, (state) =>
        state.running === null ? [null, { ...state, running: fresh }] : [state.running, state],
      );
      if (joined !== null) return yield* restore(Deferred.await(joined));
      const exit = yield* Effect.exit(restore(runCompaction));
      yield* Ref.update(compaction, (state) => ({ ...state, running: null }));
      yield* Deferred.done(fresh, exit);
      return yield* exit;
    }),
  );

  const compact = compactNow.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );
  const lastCompactedAt = yield* fs.readFileString(compactedAtPath).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => Number.NaN),
  );
  const intervalMs = Duration.toMillis(COMPACTION_INTERVAL);
  const untilDueMs = Number.isFinite(lastCompactedAt)
    ? lastCompactedAt + intervalMs - (yield* Clock.currentTimeMillis)
    : 0;
  const firstCompactionDelay = Duration.millis(
    Math.min(intervalMs, Math.max(Duration.toMillis(Duration.minutes(1)), untilDueMs)),
  );

  yield* forkParked(
    Effect.sleep(firstCompactionDelay).pipe(
      Effect.andThen(
        compact.pipe(
          Effect.andThen(publishStatus),
          Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)),
        ),
      ),
    ),
  );
  yield* forkParked(
    publishStatus.pipe(
      Effect.andThen(Effect.sleep("1 minute")),
      Effect.andThen(
        reclaim.pipe(Effect.andThen(publishStatus), Effect.repeat(Schedule.spaced("1 minute"))),
      ),
    ),
  );

  return DatabaseStorage.of({
    reclaim,
    status: SubscriptionRef.changes(statusRef),
    health: Ref.get(healthRef),
    compactNow,
  });
});

export const layer = Layer.effect(DatabaseStorage, make);
