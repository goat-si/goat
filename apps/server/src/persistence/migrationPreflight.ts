// @effect-diagnostics nodeBuiltinImport:off - the update preflight reads the ledger once, read-only.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as Migrator from "effect/sql/Migrator";

import { migrationEntries } from "./Migrations.ts";
import {
  displacedUpstreamMigrations,
  plannedGoatLedger,
  skippedV2Migrations,
} from "./reconcileGoatMigrationIds.ts";
import { reconciledV2PreviewHistory } from "./reconcileV2PreviewMigration.ts";

type LedgerRow = { readonly migration_id: number; readonly name: string };

/** The recorded ledger; [] for a database or ledger that does not exist yet, null if unreadable. */
export function readMigrationLedger(databasePath: string): ReadonlyArray<LedgerRow> | null {
  if (!NodeFS.existsSync(databasePath)) return [];
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    const ledger = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (ledger === undefined) return [];
    return db
      .prepare("SELECT migration_id, name FROM effect_sql_migrations")
      .all()
      .flatMap((row) =>
        typeof row.migration_id === "number" && typeof row.name === "string"
          ? [{ migration_id: row.migration_id, name: row.name }]
          : [],
      );
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
  history: ReadonlyArray<LedgerRow>,
  version: string,
): string | undefined {
  const entries = migrationEntries;
  const known = new Set<string>(entries.map(([, name]) => name));
  const unknown = [...new Set(history.map((row) => row.name).filter((name) => !known.has(name)))];
  if (unknown.length > 0) {
    return `This database has migrations that goat@${version} does not know: ${unknown.join(", ")}. A newer build wrote them, and running goat@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`;
  }
  const incompatible = (detail: string) =>
    `This database has incompatible migration history: ${detail} Start the build that wrote it, or report this migration history so an upgrade path can be added.`;
  const preview = reconciledV2PreviewHistory(
    history.map((row) => ({ id: row.migration_id, name: row.name })),
  );
  if (preview === null) return incompatible("an unexpected V2 preview history.");
  const reconciled = preview.map((row) => ({ migration_id: row.id, name: row.name }));
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
