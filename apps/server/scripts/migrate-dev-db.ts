#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import {
  describePrivateDevDirectoryChange,
  ensurePrivateDevDirectory,
  resolveWorktreeHome,
} from "@goat/shared/devHome";
import { GOAT_HOME_DIR_NAME } from "@goat/shared/goatHome";
import { LEGACY_HOME_DIR_NAME } from "@goat/contracts/legacyT3Names";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import { rebuildMessageSearch } from "../src/orchestration-v2/messageSearchIndex.ts";
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
import { isProtectedDestination } from "./migrate-dev-db-protected.ts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";

export class MigrateDevDbNotInWorktreeError extends Schema.TaggedError<MigrateDevDbNotInWorktreeError>()(
  "MigrateDevDbNotInWorktreeError",
  {},
) {
  override get message(): string {
    return "Not inside a linked git worktree. Pass --base-dir to target an isolated .t3 directory.";
  }
}

export class MigrateDevDbSharedHomeError extends Schema.TaggedError<MigrateDevDbSharedHomeError>()(
  "MigrateDevDbSharedHomeError",
  {},
) {
  override get message(): string {
    return "Refusing to rebuild a shared ~/.goat or ~/.t3 database. Use an isolated --base-dir.";
  }
}

export class MigrateDevDbSourceMissingError extends Schema.TaggedError<MigrateDevDbSourceMissingError>()(
  "MigrateDevDbSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database does not exist at '${this.sourcePath}'.`;
  }
}

export class MigrateDevDbSourceIsDestinationError extends Schema.TaggedError<MigrateDevDbSourceIsDestinationError>()(
  "MigrateDevDbSourceIsDestinationError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database '${this.sourcePath}' resolves to a path this command rewrites. Pick a different --source or --base-dir.`;
  }
}

export class MigrateDevDbServerRunningError extends Schema.TaggedError<MigrateDevDbServerRunningError>()(
  "MigrateDevDbServerRunningError",
  {
    databasePath: Schema.String,
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev database at '${this.databasePath}' is open by a running server (pid ${this.pid} per server-runtime.json). Stop that server first; if that pid is not actually a GOAT server (stale descriptor, reused pid), delete the server-runtime.json next to the database and retry.`;
  }
}

export class MigrateDevDbDestinationBusyError extends Schema.TaggedError<MigrateDevDbDestinationBusyError>()(
  "MigrateDevDbDestinationBusyError",
  {
    databasePath: Schema.String,
    reason: Schema.Literals(["write-locked", "wal-held"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "write-locked"
        ? "the database is write-locked"
        : "another connection is holding its WAL";
    return `Dev database at '${this.databasePath}' looks in use (${detail}). Stop the dev server first; if none is running, delete the -wal/-shm files next to it.`;
  }
}

export class MigrateDevDbSlotCollisionError extends Schema.TaggedError<MigrateDevDbSlotCollisionError>()(
  "MigrateDevDbSlotCollisionError",
  {
    slot: Schema.Number,
    codeName: Schema.String,
    appliedName: Schema.String,
  },
) {
  override get message(): string {
    return `Migration slot collision at ${this.slot}: this checkout registers '${this.codeName}' but the database already applied '${this.appliedName}' in that slot. Renumber the new migration to a free slot.`;
  }
}

export class MigrateDevDbPhaseError extends Schema.TaggedError<MigrateDevDbPhaseError>()(
  "MigrateDevDbPhaseError",
  {
    phase: Schema.Literals(["snapshot", "prune", "compact", "migrate", "verify"]),
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `migrate-dev-db failed during ${this.phase} on '${this.databasePath}'.`;
  }
}

export class MigrateDevDbDanglingForeignKeyError extends Schema.TaggedError<MigrateDevDbDanglingForeignKeyError>()(
  "MigrateDevDbDanglingForeignKeyError",
  {
    violations: Schema.String,
  },
) {
  override get message(): string {
    return `Snapshot still has dangling foreign keys after pruning: ${this.violations}`;
  }
}

export interface RunMigrateDevDbInput {
  readonly baseDir?: string | undefined;
  readonly source?: string | undefined;
  readonly projects: number;
  readonly threadsPerProject: number;
}

export interface RunMigrateDevDbOptions {
  /** Test override for the directory writes must never target. */
  readonly sharedHome?: string | undefined;
  /**
   * Homes checked in order for `userdata/statev2.sqlite` when `source` is
   * omitted. Defaults to `~/.goat`, then `~/.t3`. Writes to these homes are
   * refused either way.
   */
  readonly sourceHomes?: ReadonlyArray<string> | undefined;
}

interface KeptProject {
  readonly title: string;
  readonly threads: number;
}

interface ForeignKeyRow {
  readonly child_table: string;
  readonly id: number;
  readonly parent_table: string;
  readonly from: string;
  readonly to: string | null;
}

interface ForeignKeyConstraint {
  readonly parentTable: string;
  readonly columns: ReadonlyArray<{ readonly from: string; readonly to: string | null }>;
}

interface ForeignKeyViolation {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
}

const quoteIdent = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const groupForeignKeys = (rows: ReadonlyArray<ForeignKeyRow>) => {
  const byTable = new Map<string, Map<number, ForeignKeyConstraint>>();
  for (const row of rows) {
    let constraints = byTable.get(row.child_table);
    if (constraints === undefined) {
      constraints = new Map();
      byTable.set(row.child_table, constraints);
    }
    const existing = constraints.get(row.id);
    const column = { from: row.from, to: row.to };
    constraints.set(
      row.id,
      existing === undefined
        ? { parentTable: row.parent_table, columns: [column] }
        : { ...existing, columns: [...existing.columns, column] },
    );
  }
  return new Map(
    Array.from(byTable, ([table, constraints]) => [table, Array.from(constraints.values())]),
  );
};

const orderTablesParentsFirst = <T extends { readonly name: string }>(
  tables: ReadonlyArray<T>,
  foreignKeys: ReadonlyMap<string, ReadonlyArray<ForeignKeyConstraint>>,
): Array<T> => {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const visited = new Set<string>();
  const ordered: Array<T> = [];
  const visit = (table: T) => {
    if (visited.has(table.name)) return;
    visited.add(table.name);
    for (const fk of foreignKeys.get(table.name) ?? []) {
      if (fk.parentTable === table.name) continue;
      const parent = byName.get(fk.parentTable);
      if (parent !== undefined) visit(parent);
    }
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
};

const parentExistsPredicates = (
  childTable: string,
  constraints: ReadonlyArray<ForeignKeyConstraint>,
  primaryKeys: ReadonlyMap<string, ReadonlyArray<string>>,
  options?: { readonly includeSelf?: boolean },
): Array<string> => {
  const childRef = quoteIdent(childTable);
  return constraints.flatMap((fk) => {
    // A self-reference cannot be filtered while the table is being inserted:
    // the parent row is still in the source, not in main. Delete it afterwards.
    if (fk.parentTable === childTable && options?.includeSelf !== true) return [];
    const parentPks = primaryKeys.get(fk.parentTable) ?? [];
    const resolved = fk.columns.map((col, idx) => ({
      from: col.from,
      to: col.to ?? parentPks[idx],
    }));
    if (resolved.some((col) => col.to === undefined)) return [];
    const nullable = resolved.map((col) => `${childRef}.${quoteIdent(col.from)} IS NULL`);
    const matches = resolved.map(
      (col) => `parent.${quoteIdent(col.to!)} = ${childRef}.${quoteIdent(col.from)}`,
    );
    return [
      `(${[
        ...nullable,
        `EXISTS (SELECT 1 FROM main.${quoteIdent(fk.parentTable)} AS parent WHERE ${matches.join(" AND ")})`,
      ].join(" OR ")})`,
    ];
  });
};

const describeForeignKeyViolations = (violations: ReadonlyArray<ForeignKeyViolation>) => {
  const sample = violations
    .slice(0, 12)
    .map((row) => `${row.table} row ${row.rowid ?? "without rowid"} -> ${row.parent}`)
    .join("; ");
  const extra = violations.length > 12 ? `; and ${violations.length - 12} more` : "";
  return `${violations.length} dangling foreign key${violations.length === 1 ? "" : "s"} (${sample}${extra})`;
};

/**
 * `PRAGMA foreign_key_check` is the real constraint list. One pass deletes the
 * rows that dangle now; the next pass catches children of those rows (a
 * self-referential chain whose head was filtered out).
 */
const deleteDanglingForeignKeys = (
  sql: SqlClient.SqlClient,
  foreignKeys: ReadonlyMap<string, ReadonlyArray<ForeignKeyConstraint>>,
  primaryKeys: ReadonlyMap<string, ReadonlyArray<string>>,
) =>
  Effect.gen(function* () {
    for (let pass = 0; pass < 32; pass++) {
      const violations = yield* sql.unsafe<ForeignKeyViolation>("PRAGMA foreign_key_check")
        .unprepared;
      if (violations.length === 0) return;

      const rowidsByTable = new Map<string, Array<number>>();
      const tablesWithoutRowid = new Set<string>();
      for (const violation of violations) {
        if (violation.rowid === null || violation.rowid === undefined) {
          tablesWithoutRowid.add(violation.table);
          continue;
        }
        const rowids = rowidsByTable.get(violation.table) ?? [];
        rowids.push(Number(violation.rowid));
        rowidsByTable.set(violation.table, rowids);
      }

      let removed = 0;
      for (const [table, rowids] of rowidsByTable) {
        const unique = [...new Set(rowids)].filter((id) => Number.isInteger(id));
        for (let offset = 0; offset < unique.length; offset += 400) {
          const chunk = unique.slice(offset, offset + 400);
          if (chunk.length === 0) continue;
          yield* sql.unsafe(`DELETE FROM ${quoteIdent(table)} WHERE rowid IN (${chunk.join(",")})`)
            .unprepared;
          const [changed] = yield* sql.unsafe<{ changes: number }>("SELECT changes() AS changes")
            .unprepared;
          removed += Number(changed?.changes ?? 0);
        }
      }
      for (const table of tablesWithoutRowid) {
        const predicates = parentExistsPredicates(
          table,
          foreignKeys.get(table) ?? [],
          primaryKeys,
          { includeSelf: true },
        );
        if (predicates.length === 0) continue;
        yield* sql.unsafe(
          `DELETE FROM main.${quoteIdent(table)} WHERE NOT (${predicates.join(" AND ")})`,
        ).unprepared;
        const [changed] = yield* sql.unsafe<{ changes: number }>("SELECT changes() AS changes")
          .unprepared;
        removed += Number(changed?.changes ?? 0);
      }
      if (removed === 0) {
        return yield* new MigrateDevDbDanglingForeignKeyError({
          violations: describeForeignKeyViolations(violations),
        });
      }
    }
    const remaining = yield* sql.unsafe<ForeignKeyViolation>("PRAGMA foreign_key_check").unprepared;
    if (remaining.length > 0) {
      return yield* new MigrateDevDbDanglingForeignKeyError({
        violations: describeForeignKeyViolations(remaining),
      });
    }
  });

const removeDatabaseFiles = Effect.fn("removeDatabaseFiles")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of ["", "-wal", "-shm"]) {
    yield* fs.remove(`${databasePath}${suffix}`).pipe(Effect.orElseSucceed(() => undefined));
  }
});

const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The runtime PID catches idle servers; leftover -shm files can come from read-only connections.
const ensureNotInUse = Effect.fn("ensureDevDbNotInUse")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  const runtimeState = yield* fs
    .readFileString(runtimeStatePath)
    .pipe(Effect.flatMap(decodeServerRuntimeState), Effect.option);
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new MigrateDevDbServerRunningError({
      databasePath,
      pid: runtimeState.value.pid,
    });
  }

  if (!(yield* fs.exists(databasePath))) {
    return;
  }
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(
      (cause) =>
        new MigrateDevDbDestinationBusyError({
          databasePath,
          reason: "write-locked",
          cause,
        }),
    ),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new MigrateDevDbDestinationBusyError({
      databasePath,
      reason: "wal-held",
    });
  }
});

const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

const CLEARED_TABLES: ReadonlyArray<string> = [
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
];

const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";

// Settled threads stay: they are most of real history, and the UI shows them.
const rootIsVisible = (sql: SqlClient.SqlClient) => sql`
  root.deleted_at IS NULL
  AND json_extract(root.payload_json, '$.deletedAt') IS NULL
  AND json_extract(root.payload_json, '$.archivedAt') IS NULL`;

// A single read transaction keeps the copy consistent with concurrent server writes.
const copySourceSlice = Effect.fn("copyDevDbSourceSlice")(function* (sourcePath: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`} AS src`;
  const schema = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM src.sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`;
  const tableKinds = yield* sql<{ name: string; type: string }>`PRAGMA src.table_list`;
  const shadowTables = new Set(
    tableKinds.filter((row) => row.type === "shadow").map((row) => row.name),
  );
  const virtualTables = new Set(
    tableKinds.filter((row) => row.type === "virtual").map((row) => row.name),
  );
  const threadColumns = yield* sql<{ name: string; notnull: number }>`
    SELECT m.name, c."notnull" FROM src.sqlite_master m, pragma_table_info(m.name, 'src') c
    WHERE m.type = 'table' AND c.name = 'thread_id'`;
  const threadIdNullable = new Map(threadColumns.map((row) => [row.name, row.notnull === 0]));
  // `hidden` 2 and 3 are VIRTUAL and STORED generated columns. INSERT refuses
  // them (`cannot INSERT into generated column`), so SELECT * cannot copy a
  // table that has one — including an empty provider-thread roster.
  const columnRows = yield* sql<{ table_name: string; name: string; hidden: number; pk: number }>`
    SELECT m.name AS table_name, c.name AS name, c.hidden AS hidden, c.pk AS pk
    FROM src.sqlite_master m, pragma_table_xinfo(m.name, 'src') c
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, c.cid`;
  const writableColumns = new Map<string, Array<string>>();
  const primaryKeyRows = new Map<string, Array<{ readonly pk: number; readonly name: string }>>();
  for (const column of columnRows) {
    if (Number(column.pk) > 0) {
      const pks = primaryKeyRows.get(column.table_name) ?? [];
      pks.push({ pk: Number(column.pk), name: column.name });
      primaryKeyRows.set(column.table_name, pks);
    }
    if (Number(column.hidden) !== 0) continue;
    const names = writableColumns.get(column.table_name) ?? [];
    names.push(column.name);
    writableColumns.set(column.table_name, names);
  }
  const primaryKeys = new Map(
    Array.from(primaryKeyRows, ([table, cols]) => [
      table,
      cols.toSorted((a, b) => a.pk - b.pk).map((col) => col.name),
    ]),
  );
  const foreignKeyRows = yield* sql<ForeignKeyRow>`
    SELECT
      m.name AS child_table,
      fk.id AS id,
      fk."table" AS parent_table,
      fk."from" AS "from",
      fk."to" AS "to"
    FROM src.sqlite_master m, pragma_foreign_key_list(m.name, 'src') fk
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, fk.id, fk.seq`;
  const foreignKeys = groupForeignKeys(foreignKeyRows);
  // Creating a virtual table creates its shadow storage. Copy its logical rows once,
  // preserving rowids used by the memory index, rather than replaying shadow DDL.
  const tables = orderTablesParentsFirst(
    schema.filter((entry) => entry.type === "table" && !shadowTables.has(entry.name)),
    foreignKeys,
  );
  const filtered = tables.some((table) => table.name === "orchestration_v2_projection_threads");
  // A row that points into a cleared table cannot be copied, so whatever references one is
  // cleared with it, however far down the chain a newer migration added it.
  const references = yield* sql<{ name: string; parent: string }>`
    SELECT m.name, f."table" AS parent FROM src.sqlite_master m, pragma_foreign_key_list(m.name, 'src') f
    WHERE m.type = 'table'`;
  const cleared = new Set(CLEARED_TABLES);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, parent } of references) {
      if (cleared.has(parent) && !cleared.has(name)) {
        cleared.add(name);
        grew = true;
      }
    }
  }

  // node:sqlite turns foreign keys on by default. The thread filter drops
  // parent rows (remote_report_bindings, and any self-reference) that a child
  // row still points at, so the INSERT fails before prune can run. The pragma
  // cannot be changed inside a transaction; it would be silently ignored.
  yield* sql.unsafe("PRAGMA foreign_keys = OFF").unprepared;
  const [foreignKeyMode] = yield* sql.unsafe<{ foreign_keys: number }>("PRAGMA foreign_keys")
    .unprepared;
  if (Number(foreignKeyMode?.foreign_keys) !== 0) {
    return yield* Effect.die(
      "migrate-dev-db could not disable foreign keys before copying the snapshot",
    );
  }

  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const table of tables) yield* sql.unsafe(table.sql).unprepared;
      if (filtered) {
        yield* sql`CREATE TEMP TABLE copied_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT OR IGNORE INTO copied_threads
          SELECT family.thread_id FROM src.orchestration_v2_projection_threads family
          JOIN src.orchestration_v2_projection_threads root ON root.thread_id =
            COALESCE(json_extract(family.payload_json, '$.lineage.rootThreadId'), family.thread_id)
          WHERE ${rootIsVisible(sql)}`;
      }
      for (const { name } of tables) {
        if (cleared.has(name) || virtualTables.has(name)) continue;
        const nullable = threadIdNullable.get(name);
        const predicates: Array<string> = [];
        if (filtered) {
          if (name === "orchestration_events") {
            // Two ranges rather than `<>`, so SQLite seeks the (aggregate_kind, stream_id)
            // index instead of scanning every event.
            predicates.push(
              `((aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM copied_threads))
                OR aggregate_kind < 'thread' OR aggregate_kind > 'thread')`,
            );
          } else if (nullable !== undefined && name !== PROVIDER_SESSIONS_TABLE) {
            predicates.push(
              `(${quoteIdent("thread_id")} IN (SELECT thread_id FROM copied_threads)${nullable ? ` OR ${quoteIdent("thread_id")} IS NULL` : ""})`,
            );
          }
        }
        predicates.push(...parentExistsPredicates(name, foreignKeys.get(name) ?? [], primaryKeys));
        const filter = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
        const columns = writableColumns.get(name) ?? [];
        if (columns.length === 0) continue;
        const columnList = (virtualTables.has(name) ? ["rowid", ...columns] : columns)
          .map(quoteIdent)
          .join(", ");
        const quoted = quoteIdent(name);
        yield* sql.unsafe(
          `INSERT INTO main.${quoted} (${columnList}) SELECT ${columnList} FROM src.${quoted} ${filter}`,
        ).unprepared;
      }
      yield* sql`DELETE FROM main.sqlite_sequence`;
      yield* sql`INSERT INTO main.sqlite_sequence SELECT name, seq FROM src.sqlite_sequence`;
      // Before indexes and triggers, so a dangling row is gone before a trigger
      // observes it. Migrate opens a new connection and turns foreign keys back on.
      yield* deleteDanglingForeignKeys(sql, foreignKeys, primaryKeys);
      for (const entry of schema) {
        if (entry.type !== "table" && !shadowTables.has(entry.name))
          yield* sql.unsafe(entry.sql).unprepared;
      }
      yield* rebuildMessageSearch(sql);
    }),
  );
  yield* sql`DETACH DATABASE src`;
});

const pruneSnapshot = Effect.fn("pruneDevDbSnapshot")(function* (input: RunMigrateDevDbInput) {
  const sql = yield* SqlClient.SqlClient;

  // Usage-limit recovery also depends on settings; exclude latest-run failures and recovery choices.
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const recoveryThreadIds = yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
    projections.getRecoveryThreadIds(kind),
  );
  yield* sql`CREATE TEMP TABLE live_threads (thread_id TEXT PRIMARY KEY)`;
  for (const threadId of new Set(recoveryThreadIds.flat())) {
    yield* sql`INSERT INTO live_threads (thread_id) VALUES (${threadId})`;
  }
  yield* sql`INSERT OR IGNORE INTO live_threads (thread_id)
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL
    UNION
    SELECT r.thread_id FROM orchestration_v2_projection_runs r
    WHERE r.status = 'failed' AND r.ordinal = (
      SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
      WHERE latest.thread_id = r.thread_id)
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items item
        WHERE item.thread_id = r.thread_id
          AND item.run_id = r.run_id
          AND item.type = 'error'
          AND item.status = 'failed'
          AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
      )`;

  // Clone or drop whole thread families to preserve fork and subagent lineage reads.
  yield* sql`CREATE TEMP TABLE thread_families AS
    SELECT thread_id, updated_at,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id
    FROM orchestration_v2_projection_threads`;

  yield* sql`CREATE TEMP TABLE stopped_families AS
    SELECT f.root_id, root.project_id, MAX(f.updated_at) AS updated_at, COUNT(*) AS size
    FROM thread_families f
    JOIN orchestration_v2_projection_threads root ON root.thread_id = f.root_id
    WHERE ${rootIsVisible(sql)}
    GROUP BY f.root_id, root.project_id
    HAVING SUM(f.thread_id IN (SELECT thread_id FROM live_threads)) = 0`;

  yield* sql`CREATE TEMP TABLE kept_projects AS
    SELECT p.project_id
    FROM projection_projects p
    LEFT JOIN (
      SELECT project_id, MAX(updated_at) AS last_stopped_at
      FROM stopped_families
      GROUP BY project_id
    ) q ON q.project_id = p.project_id
    WHERE p.deleted_at IS NULL
    ORDER BY (q.last_stopped_at IS NULL) ASC,
      COALESCE(q.last_stopped_at, p.updated_at) DESC
    LIMIT ${input.projects}`;

  yield* sql`CREATE TEMP TABLE kept_threads AS
    SELECT f.thread_id FROM thread_families f
    WHERE f.root_id IN (
      SELECT root_id FROM (
        SELECT
          sf.root_id,
          ROW_NUMBER() OVER (
            PARTITION BY sf.project_id
            ORDER BY sf.updated_at DESC
          ) AS recency_rank
        FROM stopped_families sf
        JOIN kept_projects kp ON kp.project_id = sf.project_id
        -- One orchestrator family can hold hundreds of subagents and most of
        -- the database, so a family larger than the limit is skipped.
        WHERE sf.size <= ${input.threadsPerProject}
      )
      WHERE recency_rank <= ${input.threadsPerProject}
    )`;

  const threadTables = yield* sql<{ name: string }>`
    SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND c.name = 'thread_id'
      AND m.name <> ${PROVIDER_SESSIONS_TABLE}`;
  const pkRows = yield* sql<{ table_name: string; name: string; pk: number }>`
    SELECT m.name AS table_name, c.name AS name, c.pk AS pk
    FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND c.pk > 0
    ORDER BY m.name, c.pk`;
  const primaryKeys = new Map<string, Array<string>>();
  for (const row of pkRows) {
    const names = primaryKeys.get(row.table_name) ?? [];
    names.push(row.name);
    primaryKeys.set(row.table_name, names);
  }
  const foreignKeyRows = yield* sql<ForeignKeyRow>`
    SELECT
      m.name AS child_table,
      fk.id AS id,
      fk."table" AS parent_table,
      fk."from" AS "from",
      fk."to" AS "to"
    FROM sqlite_master m, pragma_foreign_key_list(m.name) fk
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
    ORDER BY m.name, fk.id, fk.seq`;
  const foreignKeys = groupForeignKeys(foreignKeyRows);
  const orderedThreadTables = orderTablesParentsFirst(threadTables, foreignKeys).toReversed();
  const orderedClearedTables = orderTablesParentsFirst(
    CLEARED_TABLES.map((name) => ({ name })),
    foreignKeys,
  ).toReversed();
  const orderedChildTables = orderTablesParentsFirst(
    Array.from(foreignKeys.keys(), (name) => ({ name })),
    foreignKeys,
  );

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe("PRAGMA defer_foreign_keys = ON").unprepared;
      yield* sql`DELETE FROM projection_projects
        WHERE project_id NOT IN (SELECT project_id FROM kept_projects)`;
      yield* sql`DELETE FROM ${sql(PROVIDER_SESSIONS_TABLE)}
        WHERE COALESCE(thread_id, '') NOT IN (SELECT thread_id FROM kept_threads)
          AND provider_session_id NOT IN (
            SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
            WHERE thread_id IN (SELECT thread_id FROM kept_threads)
          )`;
      for (const { name } of orderedThreadTables) {
        yield* sql.unsafe(
          `DELETE FROM ${quoteIdent(name)} WHERE thread_id NOT IN (SELECT thread_id FROM kept_threads)`,
        ).unprepared;
      }
      yield* sql`DELETE FROM orchestration_v2_projection_context_transfers
        WHERE source_thread_id NOT IN (SELECT thread_id FROM kept_threads)
           OR target_thread_id NOT IN (SELECT thread_id FROM kept_threads)`;
      yield* sql`DELETE FROM orchestration_events
        WHERE (aggregate_kind = 'thread'
            AND stream_id NOT IN (SELECT thread_id FROM kept_threads))
           OR (aggregate_kind = 'project'
            AND stream_id NOT IN (SELECT project_id FROM kept_projects))`;
      for (const { name } of orderedClearedTables) {
        yield* sql`DELETE FROM ${sql(name)}`;
      }
      for (const { name } of orderedChildTables) {
        const predicates = parentExistsPredicates(name, foreignKeys.get(name) ?? [], primaryKeys);
        if (predicates.length === 0) continue;
        yield* sql.unsafe(
          `DELETE FROM main.${quoteIdent(name)} WHERE NOT (${predicates.join(" AND ")})`,
        ).unprepared;
      }
      // Thread deletes can orphan a self-reference the predicate above skips.
      // Deferred checks would only fail the commit with a generic constraint error.
      yield* deleteDanglingForeignKeys(sql, foreignKeys, primaryKeys);
    }),
  );

  const keptProjects = yield* sql<{ title: string; threads: number }>`
    SELECT
      p.title,
      (SELECT COUNT(*) FROM orchestration_v2_projection_threads t
        WHERE t.project_id = p.project_id) AS threads
    FROM projection_projects p
    ORDER BY p.updated_at DESC`;
  const [events] = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events`;

  return {
    projects: keptProjects as ReadonlyArray<KeptProject>,
    eventCount: events?.count ?? 0,
  };
});

const verifyMigrationSlots = Effect.fn("verifyMigrationSlots")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations`;
  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  for (const [slot, codeName] of migrationManifest) {
    const appliedName = appliedById.get(slot);
    if (appliedName !== undefined && appliedName !== codeName) {
      return yield* new MigrateDevDbSlotCollisionError({ slot, codeName, appliedName });
    }
  }
});

export const runMigrateDevDb = Effect.fn("runMigrateDevDb")(function* (
  input: RunMigrateDevDbInput,
  options: RunMigrateDevDbOptions = {},
) {
  // Negative SQLite LIMITs mean unlimited; validate direct callers as well as CLI flags.
  if (input.projects < 1 || input.threadsPerProject < 0) {
    return yield* Effect.die("projects must be >= 1 and threadsPerProject >= 0");
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const homeDirectory = NodeOS.homedir();
  const sourceHomes = (
    options.sourceHomes ??
    [GOAT_HOME_DIR_NAME, LEGACY_HOME_DIR_NAME].map((name) => path.join(homeDirectory, name))
  ).map((home) => path.resolve(home));
  const protectedHomes = [
    ...sourceHomes,
    ...(options.sharedHome === undefined ? [] : [path.resolve(options.sharedHome)]),
  ];
  const sourceCandidates = sourceHomes.map((home) => path.join(home, "userdata", "statev2.sqlite"));
  let sourcePath = path.resolve(input.source ?? sourceCandidates[0] ?? "");
  if (input.source === undefined) {
    for (const candidate of sourceCandidates) {
      if (yield* fs.exists(candidate)) {
        sourcePath = candidate;
        break;
      }
    }
  }

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeHome(process.cwd());
  if (baseDir === undefined) {
    return yield* new MigrateDevDbNotInWorktreeError();
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  const snapshotPath = `${databasePath}.migrate-dev-db-tmp`;

  if (!(yield* fs.exists(sourcePath))) {
    return yield* new MigrateDevDbSourceMissingError({ sourcePath });
  }
  if (yield* isProtectedDestination(baseDir, protectedHomes)) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  // Both destination and snapshot are deleted below; reject sources resolving to either.
  const canonicalSourcePath = yield* fs
    .realPath(sourcePath)
    .pipe(Effect.orElseSucceed(() => sourcePath));
  for (const destination of [databasePath, snapshotPath]) {
    const canonicalDestination = yield* fs
      .realPath(destination)
      .pipe(Effect.orElseSucceed(() => destination));
    if (canonicalSourcePath === canonicalDestination) {
      return yield* new MigrateDevDbSourceIsDestinationError({ sourcePath });
    }
  }

  // Only userdata: --base-dir may be any directory, so its mode is left alone.
  const modeChange = yield* ensurePrivateDevDirectory(stateDir);
  if (modeChange !== undefined) {
    yield* Console.log(describePrivateDevDirectoryChange(stateDir, modeChange));
  }
  yield* ensureNotInUse(databasePath);

  const wrapPhase =
    (phase: MigrateDevDbPhaseError["phase"], phaseDatabasePath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new MigrateDevDbPhaseError({ phase, databasePath: phaseDatabasePath, cause }),
        ),
      );

  yield* removeDatabaseFiles(snapshotPath);
  const { executedMigrations, pruned } = yield* Effect.gen(function* () {
    yield* Console.log(`Copying visible threads from ${sourcePath} (read-only)...`);
    yield* copySourceSlice(sourcePath).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("snapshot", sourcePath),
    );

    // Migrate first so prune queries can use columns missing from older sources.
    yield* Console.log("Running migrations on the snapshot...");
    const executed = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
      return yield* runMigrations();
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("migrate", snapshotPath),
    );

    // Detect migration slot collisions before replacing the worktree database.
    yield* verifyMigrationSlots().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new MigrateDevDbPhaseError({ phase: "verify", databasePath: snapshotPath, cause }),
          ),
      }),
    );

    yield* Console.log(
      `Pruning to ${input.projects} projects, ${input.threadsPerProject} stopped threads each...`,
    );
    const result = yield* pruneSnapshot(input).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: snapshotPath })),
        ),
      ),
      wrapPhase("prune", snapshotPath),
    );

    yield* Console.log(`Compacting into ${databasePath}...`);
    // A server may have started during pruning; re-check before replacing its database.
    yield* ensureNotInUse(databasePath);
    yield* removeDatabaseFiles(databasePath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${databasePath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("compact", databasePath),
    );
    return { executedMigrations: executed, pruned: result };
  }).pipe(Effect.ensuring(removeDatabaseFiles(snapshotPath)));
  yield* fs.chmod(databasePath, 0o600);

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // VACUUM INTO loses WAL mode; restore the server boot setting.
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    wrapPhase("compact", databasePath),
  );

  const size = (yield* fs.stat(databasePath)).size;
  return {
    databasePath,
    sizeBytes: Number(size),
    projects: pruned.projects,
    eventCount: pruned.eventCount,
    executedMigrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
  };
});

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

export const migrateDevDbCommand = Command.make(
  "migrate-dev-db",
  {
    projects: Flag.Int("projects").pipe(
      Flag.withDefault(5),
      Flag.withDescription("How many recently updated projects to keep."),
    ),
    threadsPerProject: Flag.Int("threads-per-project").pipe(
      Flag.withDefault(10),
      Flag.withDescription(
        "How many recent stopped threads, with their forks and subagents, to keep per project. A family with more threads than this is skipped.",
      ),
    ),
    baseDir: Flag.String("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .t3 directory. Defaults to the current worktree's .t3."),
    ),
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription(
        "Source database. Defaults to ~/.goat/userdata/statev2.sqlite, or ~/.t3/userdata/statev2.sqlite when that file is absent.",
      ),
    ),
  },
  ({ projects, threadsPerProject, baseDir, source }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevDb({
        projects,
        threadsPerProject,
        baseDir: Option.getOrUndefined(baseDir),
        source: Option.getOrUndefined(source),
      });
      yield* Console.log("");
      yield* Console.log(
        `Dev database ready: ${result.databasePath} (${formatSize(result.sizeBytes)})`,
      );
      for (const project of result.projects) {
        yield* Console.log(`  ${project.title}: ${project.threads} threads`);
      }
      yield* Console.log(`  ${result.eventCount} orchestration events kept`);
      yield* Console.log(
        result.executedMigrations.length === 0
          ? "  Migrations: already current (no new migrations in this checkout)"
          : `  Migrations applied: ${result.executedMigrations.join(", ")}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Rebuild the worktree dev database from a pruned snapshot of the real ~/.goat data (or ~/.t3 when that database is absent), then run migrations.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevDbCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
