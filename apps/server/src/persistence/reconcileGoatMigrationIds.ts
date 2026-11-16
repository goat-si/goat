import { DATABASE_MIGRATION_PROGRESS_MESSAGE } from "@goat/shared/databaseMigrationLog";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export const FIRST_V2_MIGRATION_ID = 55;

/**
 * GOAT's own migrations, which sit after upstream's in `migrationEntries`. An upstream sync that
 * adds ids GOAT already used moves these up; the names stay stable.
 */
export const GOAT_MIGRATION_NAMES: ReadonlySet<string> = new Set([
  "ServerActivityIndexes",
  "RemoteReports",
  "RemoteDispatches",
  "ChannelLedger",
  "RemoteDispatchQuestions",
  "ThreadRunResults",
  "RemoteReportRelay",
  "ProjectionTurnItemRequestIndex",
  "Memory",
  "MemoryHubSync",
  "MemorySearchCounters",
  "MemoryTaskGrantCeiling",
  "MemoryImportLineage",
  "MemoryCheckpointAccounting",
  "MemoryReportLifecycle",
  "MemoryUsageCounters",
  "MemoryRevertResults",
  "HandoffLookupIndex",
  "MemoryLastReadySpace",
  "MemoryHubAdministered",
  "MemoryCheckpointLifecycle",
  "FleetGoals",
  "FleetHealth",
  "ThreadRunObservedChecks",
  "RemoteDispatchObservation",
  "MemoryRevisionCheckpointSize",
  "HubNodes",
  "MemorySummaryWorkThreadIndex",
  "ThreadHistoryArchives",
  "PermissionProfiles",
  "DecisionInbox",
  "HumanStepRecords",
  "McpRequestReservations",
  "RemoteReportInboxRunId",
  "RemoteReportReceipts",
  "PendingAttachmentUploads",
  "ScheduledTaskWebhookSecretRef",
  "RemoteReportFences",
  "HubProvisionedLinks",
  "ScheduledTaskRuns",
  "ScheduledTaskNotificationPolicy",
  "NotificationCursorRepair",
  "ConnectLinkTrust",
  "McpEvalJournal",
  "DecisionRoutes",
  "HubConnectAccess",
  "ChannelBotSessions",
  "MemoryGenerationReportBacklog",
  "ChannelSessionReceipts",
  "BrowserSiteNotes",
  "ComputerUseSessionApprovals",
  "ComputerUseNamedApprovals",
  "ComputerUseInputHistory",
  "MemoryCheckpointBound",
  "WorktreeSnapshots",
  "ChannelBotIds",
  "ScheduledBotRoutines",
  "RemoteDispatchDeleteIntent",
  "ChannelInterimMessages",
  "ChannelNewestAsk",
  "PlacementAdmission",
  "AuthSessionPenBinding",
  "ChannelOutboxOperations",
  "RemoteDispatchHostOutage",
  "ChannelBotTaskHistory",
  "DisposableMachines",
  "DisposableMachineRequests",
  "DisposableMachineEnrollment",
]);

type MigrationEntry<E> = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<unknown, E, SqlClient.SqlClient>,
];

/** Whether a recorded GOAT migration sits off its current id, so reconciliation would move it. */
export const goatMigrationIdsMove = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
): boolean => {
  const currentIds = new Map(entries.map(([id, name]) => [name, id]));
  return history.some(
    (row) => GOAT_MIGRATION_NAMES.has(row.name) && currentIds.get(row.name) !== row.migration_id,
  );
};

/**
 * The upstream migrations an id shift displaced: the unrecorded tail above the highest upstream id
 * the ledger records below GOAT's block, up to its highest GOAT row. A gap below that tail is a
 * lost ledger row, which keeps the migrator's rules (`skippedV2Migrations`).
 */
export const displacedUpstreamMigrations = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
): ReadonlyArray<MigrationEntry<E>> => {
  const currentIds = new Map(entries.map(([id, name]) => [name, id]));
  const highestGoat = Math.max(
    0,
    ...history.map((row) =>
      GOAT_MIGRATION_NAMES.has(row.name) ? (currentIds.get(row.name) ?? 0) : 0,
    ),
  );
  const highestUpstream = highestUpstreamBelowGoat(entries, history);
  const recordedIds = new Set(history.map((row) => row.migration_id));
  return entries.filter(
    ([id, name]) =>
      !GOAT_MIGRATION_NAMES.has(name) &&
      id > highestUpstream &&
      id < highestGoat &&
      !recordedIds.has(id),
  );
};

const highestUpstreamBelowGoat = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
) => {
  const firstGoatId = Math.min(
    ...entries.flatMap(([id, name]) => (GOAT_MIGRATION_NAMES.has(name) ? [id] : [])),
  );
  return Math.max(
    0,
    ...history.flatMap((row) =>
      !GOAT_MIGRATION_NAMES.has(row.name) && row.migration_id < firstGoatId
        ? [row.migration_id]
        : [],
    ),
  );
};

/**
 * V2 migrations up to `upTo` that the ledger does not record under their name: the migrator skips
 * them. `highestRecorded` is the ledger's highest id, for the message.
 */
export const skippedV2Migrations = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
  upTo: number,
  throughId?: number,
  highestRecorded = upTo,
) => {
  const recordedNames = new Map(history.map((row) => [row.migration_id, row.name]));
  const skipped = entries.flatMap(([id, name]) => {
    if (id < FIRST_V2_MIGRATION_ID || id > upTo || (throughId !== undefined && id > throughId))
      return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  return skipped.length === 0
    ? undefined
    : new Migrator.MigrationError({
        kind: "BadState",
        message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${highestRecorded}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
      });
};

/**
 * Read-only preflight: preview reconciliation must not mutate incompatible memory sandboxes.
 *
 * An upstream sync moves every recorded GOAT migration by the same distance, so a released ledger
 * keeps one offset between its recorded and current GOAT ids and reconciliation can move it. The
 * migrator also runs them in order, so a released ledger that recorded a memory migration recorded
 * every GOAT migration before it. A memory ledger with mixed offsets, a gap before a memory row, or
 * a memory name this build does not know came from an unreleased layout, and its tables may not
 * match the current schema.
 */
export const assertMemoryMigrationsCompatible = Effect.fn("assertMemoryMigrationsCompatible")(
  function* <E>(entries: ReadonlyArray<MigrationEntry<E>>) {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND (name = 'effect_sql_migrations' OR name GLOB 'memory_*')
    `;
    const hasLedger = tables.some((table) => table.name === "effect_sql_migrations");
    const history = hasLedger
      ? yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
        `
      : [];
    const currentIds = new Map(entries.map(([id, name]) => [name, id]));
    const memoryRows = history.filter((row) => row.name.startsWith("Memory"));
    const goatOffsets = new Set(
      history.flatMap((row) => {
        const currentId = currentIds.get(row.name);
        const goatRow = GOAT_MIGRATION_NAMES.has(row.name) || row.name.startsWith("Memory");
        return goatRow && currentId !== undefined ? [row.migration_id - currentId] : [];
      }),
    );
    const recordedNames = new Set(history.map((row) => row.name));
    const skipsEarlierGoat = memoryRows.some((row) => {
      const memoryId = currentIds.get(row.name);
      return (
        memoryId !== undefined &&
        entries.some(
          ([id, name]) =>
            GOAT_MIGRATION_NAMES.has(name) && id < memoryId && !recordedNames.has(name),
        )
      );
    });
    const incompatibleLedger =
      memoryRows.length > 0 &&
      (memoryRows.some((row) => !currentIds.has(row.name)) ||
        goatOffsets.size > 1 ||
        skipsEarlierGoat);
    const unrecordedMemory =
      tables.some((table) => table.name.startsWith("memory_")) &&
      !history.some((row) => row.name === "Memory");
    // Preserve the evidence of unreleased memory before any startup reconciliation writes.
    if (incompatibleLedger || unrecordedMemory) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          "Unreleased memory DB is incompatible; reset this sandbox's memory development state and restart.",
      });
    }
  },
);

const readHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (ledger.length === 0) return undefined;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
  `;
});

/** Runs the next displaced upstream migration and records it, in the caller's transaction. */
const runNextDisplaced = Effect.fn("reconcileGoatMigrationIds.runNextDisplaced")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
) {
  const sql = yield* SqlClient.SqlClient;
  const [next] = displacedUpstreamMigrations(entries, history);
  if (next === undefined) return undefined;
  const [id, name, migration] = next;
  yield* migration.pipe(
    Effect.mapError(
      (cause) =>
        new Migrator.MigrationError({
          kind: "Failed",
          message: `Migration ${id}_${name} failed: ${String(cause)}`,
        }),
    ),
  );
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  return [id, name] as const;
});

/**
 * Moves recorded GOAT migrations to their current ids, refusing before any write when one would
 * land on an id another migration recorded. The first displaced upstream migration commits with
 * the move: a build from before the shift, reading a moved ledger that holds only names it knows,
 * would move it back and start; with that name recorded it refuses as a newer database (exit 79).
 */
const moveGoatLedger = Effect.fn("reconcileGoatMigrationIds.moveGoatLedger")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* assertMemoryMigrationsCompatible(entries);
  const history = yield* readHistory;
  if (history === undefined || !goatMigrationIdsMove(entries, history)) return [];
  const currentIds = new Map(entries.map(([id, name]) => [name, id]));
  const goatRows = history.flatMap((row) => {
    const id = GOAT_MIGRATION_NAMES.has(row.name) ? currentIds.get(row.name) : undefined;
    return id === undefined ? [] : [{ migration_id: id, name: row.name }];
  });
  const upstreamRows = new Map(
    history
      .filter((row) => !GOAT_MIGRATION_NAMES.has(row.name))
      .map((row) => [row.migration_id, row.name]),
  );
  const unknownGoat = history.some(
    (row) => GOAT_MIGRATION_NAMES.has(row.name) && !currentIds.has(row.name),
  );
  if (unknownGoat || goatRows.some((row) => upstreamRows.has(row.migration_id))) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: "Cannot move GOAT migrations onto ids another migration recorded.",
    });
  }
  const highestMoved = Math.max(0, ...goatRows.map((row) => row.migration_id));
  for (const [id, name] of entries) {
    const recorded = upstreamRows.get(id);
    // Below V2, other histories (v1 cutovers, site-local migrations) keep their own names.
    if (GOAT_MIGRATION_NAMES.has(name) || id > highestMoved || id < FIRST_V2_MIGRATION_ID) continue;
    if (recorded === undefined) continue;
    if (recorded !== name) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Migration ${id} is recorded as ${recorded}, expected ${name}.`,
      });
    }
  }
  const moved = [...history.filter((row) => !GOAT_MIGRATION_NAMES.has(row.name)), ...goatRows];
  // Every upstream id below GOAT's old block was recorded before the shift, so a gap there is lost.
  const lowestGoatBefore = Math.min(
    ...history.flatMap((row) => (GOAT_MIGRATION_NAMES.has(row.name) ? [row.migration_id] : [])),
  );
  const skipped = skippedV2Migrations(
    entries,
    moved,
    Math.max(lowestGoatBefore - 1, highestUpstreamBelowGoat(entries, moved)),
    undefined,
    Math.max(0, ...history.map((row) => row.migration_id)),
  );
  if (skipped !== undefined) return yield* skipped;
  yield* sql`DELETE FROM effect_sql_migrations WHERE name IN ${sql.in(goatRows.map((row) => row.name))}`;
  for (const row of goatRows) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${row.migration_id}, ${row.name})`;
  }
  const first = yield* runNextDisplaced(entries, moved);
  return first === undefined ? [] : [first];
});

/**
 * The migrator skips ids at or below the highest recorded, so it never runs an upstream migration
 * whose id GOAT recorded first. This moves GOAT's rows to their current ids, then runs each
 * displaced upstream migration in its own transaction, so a restart resumes after the last one
 * that finished. Those migrations must be rerun-safe.
 */
export const reconcileGoatMigrationIds = Effect.fn("reconcileGoatMigrationIds")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
) {
  const sql = yield* SqlClient.SqlClient;
  const executed: Array<readonly [number, string]> = [
    ...(yield* sql.withTransaction(moveGoatLedger(entries))),
  ];
  const pending = displacedUpstreamMigrations(entries, (yield* readHistory) ?? []);
  for (const [index, [id, name]] of pending.entries()) {
    yield* Effect.log(DATABASE_MIGRATION_PROGRESS_MESSAGE).pipe(
      Effect.annotateLogs({
        migration: `${id}_${name}`,
        progress: `${index + 1} of ${pending.length}`,
      }),
    );
    // Each step reads the ledger again in its transaction, so it runs whatever is next.
    const ran = yield* sql.withTransaction(
      Effect.gen(function* () {
        const history = yield* readHistory;
        return history === undefined ? undefined : yield* runNextDisplaced(entries, history);
      }),
    );
    if (ran === undefined) break;
    executed.push(ran);
  }
  return executed;
});
