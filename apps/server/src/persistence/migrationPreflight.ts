// @effect-diagnostics nodeBuiltinImport:off - the update preflight reads the ledger once, read-only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Migrator from "effect/sql/Migrator";

import { V1_DATABASE_FILENAME } from "./initializeV2Database.ts";
import { migrationEntries } from "./Migrations.ts";
import {
  canonicalMigrationName,
  displacedUpstreamMigrations,
  memoryMigrationProblem,
  normalizeBotAttentionPreview,
  plannedGoatLedger,
  skippedV2Migrations,
} from "./reconcileGoatMigrationIds.ts";
import { reconciledV2PreviewHistory } from "./reconcileV2PreviewMigration.ts";

type LedgerRow = { readonly migration_id: number; readonly name: string };
interface MigrationSnapshot {
  readonly history: ReadonlyArray<LedgerRow>;
  readonly hasMemoryTables: boolean;
}

function databaseExists(databasePath: string): boolean {
  const entry = NodeFS.lstatSync(databasePath, { throwIfNoEntry: false });
  if (entry === undefined) return false;
  if (entry.isSymbolicLink()) NodeFS.statSync(databasePath);
  return true;
}

/** Uses the existing V2 database, or the V1 source startup would import. */
export function resolveMigrationSnapshotPath(databasePath: string): string | undefined | null {
  try {
    if (databaseExists(databasePath)) return databasePath;
    const sourcePath = NodePath.join(NodePath.dirname(databasePath), V1_DATABASE_FILENAME);
    if (sourcePath !== databasePath && databaseExists(sourcePath)) return sourcePath;
    return undefined;
  } catch {
    return null;
  }
}

/** Reads startup's migration evidence without modifying the database. */
export function readMigrationSnapshot(databasePath: string): MigrationSnapshot | null {
  const selectedPath = resolveMigrationSnapshotPath(databasePath);
  if (selectedPath === null) return null;
  if (selectedPath === undefined) return { history: [], hasMemoryTables: false };
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(selectedPath, { readOnly: true });
    db.exec("BEGIN");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'effect_sql_migrations' OR name GLOB 'memory_*')",
      )
      .all();
    const history: LedgerRow[] = [];
    if (tables.some((table) => table.name === "effect_sql_migrations")) {
      for (const row of db.prepare("SELECT migration_id, name FROM effect_sql_migrations").all()) {
        if (typeof row.migration_id !== "number" || typeof row.name !== "string") return null;
        history.push({ migration_id: row.migration_id, name: row.name });
      }
    }
    return {
      history,
      hasMemoryTables: tables.some((table) => String(table.name).startsWith("memory_")),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Why this build cannot start on a database with this ledger, checked as startup would see it:
 * after the V2 preview reconciliation and GOAT's id move with the upstream migrations it runs.
 */
export function migrationLedgerProblem(
  { history, hasMemoryTables }: MigrationSnapshot,
  version: string,
): string | undefined {
  const entries = migrationEntries;
  const known = new Set<string>(entries.map(([, name]) => name));
  const unknown = [
    ...new Set(
      history.map((row) => row.name).filter((name) => !known.has(canonicalMigrationName(name))),
    ),
  ];
  if (unknown.length > 0) {
    return `This database has migrations that goat@${version} does not know: ${unknown.join(", ")}. A newer build wrote them, and running goat@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`;
  }
  const incompatible = (detail: string) =>
    `This database has incompatible migration history: ${detail} Start the build that wrote it, or report this migration history so an upgrade path can be added.`;
  const memory = memoryMigrationProblem(entries, history, hasMemoryTables);
  if (memory !== undefined) return memory.message;
  const preview = reconciledV2PreviewHistory(
    history.map((row) => ({ id: row.migration_id, name: row.name })),
  );
  if (preview === null) return incompatible("an unexpected V2 preview history.");
  const { history: reconciled } = normalizeBotAttentionPreview(
    entries,
    preview.map((row) => ({ migration_id: row.id, name: row.name })),
  );
  const plan = plannedGoatLedger(entries, reconciled);
  if (plan instanceof Migrator.MigrationError) return incompatible(plan.message);
  const moved = plan?.moved ?? reconciled;
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
  return skipped?.message;
}
