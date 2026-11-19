import { DATABASE_MIGRATION_PROGRESS_MESSAGE } from "@goat/shared/databaseMigrationLog";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

export const FIRST_V2_MIGRATION_ID = 55;

const CHANNEL_LEDGER_MIGRATION = "ChannelLedger";
const WORK_TRIGGER_LEDGER_FENCE = "ChannelLedgerRequiresWorkTriggerAuthority";
const WORKER_RELEASE_LEDGER_FENCE = "ChannelLedgerRequiresWorkerReleaseAuthority";
export const WORK_TRIGGER_FENCE_MIGRATION_NAME = "WorkTriggerAuthorityFence";
export const WORKER_GENERATIONS_MIGRATION_NAME = "ChannelWorkerGenerations";

// Older builds already reject a changed name at a required V2 migration id.
export const canonicalMigrationName = (name: string) =>
  name === WORK_TRIGGER_LEDGER_FENCE || name === WORKER_RELEASE_LEDGER_FENCE
    ? CHANNEL_LEDGER_MIGRATION
    : name;

export const fenceWorkTriggerRollback = Effect.fn("fenceWorkTriggerRollback")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE effect_sql_migrations SET name = ${WORK_TRIGGER_LEDGER_FENCE}
    WHERE name = ${CHANNEL_LEDGER_MIGRATION}`;
});

export const fenceWorkerReleaseRollback = Effect.fn("fenceWorkerReleaseRollback")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE effect_sql_migrations SET name = ${WORKER_RELEASE_LEDGER_FENCE}
    WHERE name IN (${CHANNEL_LEDGER_MIGRATION}, ${WORK_TRIGGER_LEDGER_FENCE})`;
});

export const reconcileWorkerReleaseRollback = Effect.fn("reconcileWorkerReleaseRollback")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const [ledger] = yield* sql<{ readonly name: string }>`SELECT name FROM effect_sql_migrations
      WHERE name IN (${CHANNEL_LEDGER_MIGRATION}, ${WORK_TRIGGER_LEDGER_FENCE}) LIMIT 1`;
    if (ledger === undefined) return;
    if (ledger.name === CHANNEL_LEDGER_MIGRATION && !(yield* hasPersistedWorkTriggers())) return;
    yield* fenceWorkerReleaseRollback();
  },
);

export const hasPersistedWorkTriggers = Effect.fn("hasPersistedWorkTriggers")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Migration 177 and databases that recorded the preview of 179 can lack these indexes.
  const indexes = yield* sql<{ readonly name: string }>`SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name IN ('scheduled_tasks_work_trigger_idx',
      'scheduled_task_channel_inputs_work_trigger_idx', 'channel_tasks_work_trigger_idx')`;
  const useIndex = (name: string) =>
    indexes.some((index) => index.name === name) ? sql`INDEXED BY ${sql(name)}` : sql``;
  const rows = yield* sql`SELECT 1 WHERE EXISTS (
    SELECT 1 FROM scheduled_tasks ${useIndex("scheduled_tasks_work_trigger_idx")}
      WHERE CASE WHEN json_valid(owner_json) THEN json_extract(owner_json, '$.routineMode') END = 'work'
    UNION ALL
    SELECT 1 FROM scheduled_task_channel_inputs ${useIndex("scheduled_task_channel_inputs_work_trigger_idx")}
      WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.routineMode') END = 'work'
    UNION ALL
    SELECT 1 FROM channel_tasks ${useIndex("channel_tasks_work_trigger_idx")}
      WHERE CASE WHEN json_valid(task_json) THEN json_extract(task_json, '$.routineWork') END = 1
    LIMIT 1)`;
  return rows.length > 0;
});

const PEN_MEMBER_MIGRATION_ID = 158;
const PEN_MEMBER_MIGRATION_NAME = "AuthSessionPenMember";
const LEGACY_FIRST_BIND_ID = 159;
const FIRST_BIND_MIGRATION_NAME = "ScheduledTaskFirstBindIntent";
const BOT_ATTENTION_MIGRATION_NAME = "ChannelBotAttention";
const BOT_ATTENTION_PREVIEW_PREDECESSORS = [
  [176, "ChannelWorkerLaunchHeads"],
  [177, WORK_TRIGGER_FENCE_MIGRATION_NAME],
] as const;
const prePenMemberMemoryNames = [
  "MemoryThreadLineage",
  "MemorySaveSuggestions",
  "MemoryHubFloor",
  "MemoryScopeVersion",
  "MemoryCompactMoveReceipts",
  "MemoryOriginCatchup",
] as const;

/**
 * GOAT's own migrations, which sit after upstream's in `migrationEntries`. An upstream sync that
 * adds ids GOAT already used moves these up; the names stay stable.
 */
export const GOAT_MIGRATION_NAMES: ReadonlySet<string> = new Set([
  "ServerActivityIndexes",
  "RemoteReports",
  "RemoteDispatches",
  CHANNEL_LEDGER_MIGRATION,
  WORK_TRIGGER_LEDGER_FENCE,
  WORKER_RELEASE_LEDGER_FENCE,
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
  PEN_MEMBER_MIGRATION_NAME,
  ...prePenMemberMemoryNames,
  "MemorySuggestionQuota",
  FIRST_BIND_MIGRATION_NAME,
  "QueuedTurnInputIndexJsonValid",
  "TurnItemMessageOrdinalIndex",
  "TurnItemInlineWorkOutput",
  "RepairStaleTitleRegeneration",
  "AcpSessionOwnerIndex",
  "ChannelWorkerLaunchHeads",
  WORK_TRIGGER_FENCE_MIGRATION_NAME,
  "WebhookDeliveryFiringEvidence",
  WORKER_GENERATIONS_MIGRATION_NAME,
  "ChannelBotTaskSnooze",
  BOT_ATTENTION_MIGRATION_NAME,
  "RemoteDispatchEnvironment",
  "BackgroundRecoveryIndexes",
  "TurnStartReadIndexes",
]);

type MigrationEntry<E> = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<unknown, E, SqlClient.SqlClient>,
];

const findPenMemberInsertion = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
) => {
  // Only a contiguous prefix of the original six memory rows can occupy the old ids.
  const tail = history.filter((row) => row.migration_id >= PEN_MEMBER_MIGRATION_ID);
  if (
    tail.length === 0 ||
    !tail.every(({ migration_id, name }) => {
      const index = migration_id - PEN_MEMBER_MIGRATION_ID;
      return index < tail.length && prePenMemberMemoryNames[index] === name;
    })
  ) {
    return undefined;
  }
  const byName = new Map<string, MigrationEntry<E>>(entries.map((entry) => [entry[1], entry]));
  const insertion = byName.get(PEN_MEMBER_MIGRATION_NAME);
  return insertion?.[0] === PEN_MEMBER_MIGRATION_ID &&
    prePenMemberMemoryNames.every(
      (name, index) => byName.get(name)?.[0] === PEN_MEMBER_MIGRATION_ID + index + 1,
    )
    ? insertion
    : undefined;
};

function legacyFirstBindId<E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<LedgerRow>,
) {
  const current = entries.find(
    ([id, name]) => id > LEGACY_FIRST_BIND_ID && name === FIRST_BIND_MIGRATION_NAME,
  );
  const tail = history.filter((row) => row.migration_id >= LEGACY_FIRST_BIND_ID);
  return current !== undefined &&
    tail.length === 1 &&
    tail.some(
      (row) => row.migration_id === LEGACY_FIRST_BIND_ID && row.name === FIRST_BIND_MIGRATION_NAME,
    )
    ? current[0]
    : undefined;
}

function legacyBotAttentionId<E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<LedgerRow>,
) {
  const latest = history.reduce<LedgerRow | undefined>(
    (highest, row) =>
      highest === undefined || row.migration_id > highest.migration_id ? row : highest,
    undefined,
  );
  const current = entries.find(([, name]) => name === BOT_ATTENTION_MIGRATION_NAME);
  if (latest?.name !== BOT_ATTENTION_MIGRATION_NAME || current === undefined) return undefined;
  const previewId = latest.migration_id;
  if (previewId < 176 || previewId > 178 || previewId >= current[0]) return undefined;
  return BOT_ATTENTION_PREVIEW_PREDECESSORS.every(
    ([id, name]) =>
      id >= previewId || history.some((row) => row.migration_id === id && row.name === name),
  )
    ? previewId
    : undefined;
}

export function normalizeBotAttentionPreview<E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<LedgerRow>,
) {
  const previewId = legacyBotAttentionId(entries, history);
  return {
    previewId,
    history:
      previewId === undefined ? history : history.filter((row) => row.migration_id !== previewId),
  };
}

/** Whether a recorded GOAT migration sits off its current id, so reconciliation would move it. */
export const goatMigrationIdsMove = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
): boolean => {
  const currentIds = new Map(entries.map(([id, name]) => [name, id]));
  return history.some(
    (row) =>
      GOAT_MIGRATION_NAMES.has(row.name) &&
      currentIds.get(canonicalMigrationName(row.name)) !== row.migration_id,
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
      GOAT_MIGRATION_NAMES.has(row.name)
        ? (currentIds.get(canonicalMigrationName(row.name)) ?? 0)
        : 0,
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
  const supportsWorkTriggers = entries.some(
    ([, name]) => name === WORK_TRIGGER_FENCE_MIGRATION_NAME,
  );
  const supportsWorkerRelease = entries.some(
    ([, name]) => name === WORKER_GENERATIONS_MIGRATION_NAME,
  );
  const recordedNames = new Map(
    history.map(({ migration_id, name }) => {
      const supported =
        name === WORKER_RELEASE_LEDGER_FENCE ? supportsWorkerRelease : supportsWorkTriggers;
      return [migration_id, supported ? canonicalMigrationName(name) : name];
    }),
  );
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
 * An upstream sync moves every recorded GOAT migration by the same distance. The memory
 * reliability branch also had a known layout where Pen member auth shifts only the memory tail.
 * Other mixed offsets, gaps before memory rows, and unknown memory names may have incompatible
 * schema.
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
    const problem = memoryMigrationProblem(
      entries,
      history,
      tables.some((table) => table.name.startsWith("memory_")),
    );
    if (problem !== undefined) return yield* problem;
  },
);

export function memoryMigrationProblem<E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
  hasMemoryTables: boolean,
): Migrator.MigrationError | undefined {
  const currentIds = new Map(entries.map(([id, name]) => [name, id]));
  const insertion = findPenMemberInsertion(entries, history);
  const firstBindId = legacyFirstBindId(entries, history);
  const legacyAttention = legacyBotAttentionId(entries, history);
  const memoryRows = history.filter((row) => row.name.startsWith("Memory"));
  const goatOffsets = new Set(
    history.flatMap((row) => {
      if (row.migration_id === legacyAttention) return [];
      const currentId = currentIds.get(canonicalMigrationName(row.name));
      const goatRow = GOAT_MIGRATION_NAMES.has(row.name) || row.name.startsWith("Memory");
      const recordedId =
        row.name === FIRST_BIND_MIGRATION_NAME && firstBindId !== undefined
          ? firstBindId
          : row.migration_id +
            (insertion !== undefined && row.migration_id >= insertion[0] ? 1 : 0);
      return goatRow && currentId !== undefined ? [recordedId - currentId] : [];
    }),
  );
  const recordedNames = new Set(history.map((row) => canonicalMigrationName(row.name)));
  const skipsEarlierGoat = memoryRows.some((row) => {
    const memoryId = currentIds.get(canonicalMigrationName(row.name));
    return (
      memoryId !== undefined &&
      entries.some(
        ([id, name]) =>
          GOAT_MIGRATION_NAMES.has(name) &&
          id < memoryId &&
          name !== insertion?.[1] &&
          !recordedNames.has(name),
      )
    );
  });
  const incompatibleLedger =
    memoryRows.length > 0 &&
    (memoryRows.some((row) => !currentIds.has(canonicalMigrationName(row.name))) ||
      goatOffsets.size > 1 ||
      skipsEarlierGoat);
  const unrecordedMemory = hasMemoryTables && !history.some((row) => row.name === "Memory");
  if (incompatibleLedger || unrecordedMemory) {
    return new Migrator.MigrationError({
      kind: "BadState",
      message:
        "Unreleased memory DB is incompatible; reset this sandbox's memory development state and restart.",
    });
  }
}

const readHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const ledger =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (ledger.length === 0) return undefined;
  return yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations
  `;
});

const runAndRecordMigration = Effect.fn("reconcileGoatMigrationIds.runAndRecordMigration")(
  function* <E>([id, name, migration]: MigrationEntry<E>) {
    const sql = yield* SqlClient.SqlClient;
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
  },
);

/** Runs the next displaced upstream migration and records it, in the caller's transaction. */
const runNextDisplaced = Effect.fn("reconcileGoatMigrationIds.runNextDisplaced")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<{ readonly migration_id: number; readonly name: string }>,
) {
  const [next] = displacedUpstreamMigrations(entries, history);
  if (next === undefined) return undefined;
  return yield* runAndRecordMigration(next);
});

type LedgerRow = { readonly migration_id: number; readonly name: string };

/**
 * The ledger moveGoatLedger would leave, or the error it refuses with; undefined when nothing
 * moves. Pure, so the update preflight reaches the same answer without writing.
 */
export const plannedGoatLedger = <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
  history: ReadonlyArray<LedgerRow>,
):
  | {
      readonly moved: ReadonlyArray<LedgerRow>;
      readonly goatRows: ReadonlyArray<LedgerRow>;
      readonly insertions: ReadonlyArray<MigrationEntry<E>>;
    }
  | Migrator.MigrationError
  | undefined => {
  if (!goatMigrationIdsMove(entries, history)) return undefined;
  const currentIds = new Map(entries.map(([id, name]) => [name, id]));
  const goatRows = history.flatMap((row) => {
    const id = GOAT_MIGRATION_NAMES.has(row.name)
      ? currentIds.get(canonicalMigrationName(row.name))
      : undefined;
    return id === undefined ? [] : [{ migration_id: id, name: row.name }];
  });
  const upstreamRows = new Map(
    history
      .filter((row) => !GOAT_MIGRATION_NAMES.has(row.name))
      .map((row) => [row.migration_id, row.name]),
  );
  const unknownGoat = history.some(
    (row) =>
      GOAT_MIGRATION_NAMES.has(row.name) && !currentIds.has(canonicalMigrationName(row.name)),
  );
  if (unknownGoat || goatRows.some((row) => upstreamRows.has(row.migration_id))) {
    return new Migrator.MigrationError({
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
      return new Migrator.MigrationError({
        kind: "BadState",
        message: `Migration ${id} is recorded as ${recorded}, expected ${name}.`,
      });
    }
  }
  const penMember = findPenMemberInsertion(entries, history);
  const firstBindId = legacyFirstBindId(entries, history);
  const insertions =
    firstBindId !== undefined
      ? entries.filter(([id]) => id >= LEGACY_FIRST_BIND_ID && id < firstBindId)
      : penMember === undefined
        ? []
        : [penMember];
  const moved = [
    ...history.filter((row) => !GOAT_MIGRATION_NAMES.has(row.name)),
    ...goatRows,
    ...insertions.map(([migration_id, name]) => ({ migration_id, name })),
  ];
  // Every upstream id below GOAT's old block was recorded before the shift, so a gap there is lost.
  const lowestGoatBefore = Math.min(
    ...history.flatMap((row) => (GOAT_MIGRATION_NAMES.has(row.name) ? [row.migration_id] : [])),
  );
  const skipped = skippedV2Migrations(
    entries,
    moved,
    firstBindId ?? Math.max(lowestGoatBefore - 1, highestUpstreamBelowGoat(entries, moved)),
    undefined,
    Math.max(0, ...history.map((row) => row.migration_id)),
  );
  return skipped ?? { moved, goatRows, insertions };
};

/**
 * Moves recorded GOAT migrations to their current ids, refusing before any write when one would
 * land on an id another migration recorded. Inserted GOAT migrations commit with the move so an
 * interruption cannot leave required migrations below an already-recorded id.
 */
const moveGoatLedger = Effect.fn("reconcileGoatMigrationIds.moveGoatLedger")(function* <E>(
  entries: ReadonlyArray<MigrationEntry<E>>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* assertMemoryMigrationsCompatible(entries);
  const history = yield* readHistory;
  if (history === undefined) return [];
  const normalized = normalizeBotAttentionPreview(entries, history);
  const plan = plannedGoatLedger(entries, normalized.history);
  if (plan instanceof Migrator.MigrationError) return yield* plan;
  if (normalized.previewId !== undefined) {
    const moved = plan?.moved ?? normalized.history;
    const final = [
      ...moved,
      ...displacedUpstreamMigrations(entries, moved).map(([id, name]) => ({
        migration_id: id,
        name,
      })),
    ];
    const skipped = skippedV2Migrations(
      entries,
      final,
      Math.max(0, ...final.map((row) => row.migration_id)),
    );
    if (skipped !== undefined) return yield* skipped;
    // The preview already wrote the table. Replay its idempotent migration after earlier ids run.
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${normalized.previewId}
      AND name = ${BOT_ATTENTION_MIGRATION_NAME}`;
  }
  if (plan === undefined) return [];
  const { moved, goatRows, insertions } = plan;
  yield* sql`DELETE FROM effect_sql_migrations WHERE name IN ${sql.in(goatRows.map((row) => row.name))}`;
  for (const row of goatRows) {
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${row.migration_id}, ${row.name})`;
  }
  if (insertions.length > 0) {
    return yield* Effect.forEach(insertions, runAndRecordMigration);
  }
  // The new upstream name prevents older builds from moving the ledger back and starting.
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
