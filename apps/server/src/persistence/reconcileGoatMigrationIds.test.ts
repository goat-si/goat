import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";

// GOAT builds before the upstream sync that added PullRequestReviewGuides at 61 recorded
// GOAT's own migrations at 61 and up.
const seedGoatLedger = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 60 });
    const byName = new Map<string, (typeof migrationEntries)[number][2]>(
      migrationEntries.map(([, name, migration]) => [name, migration]),
    );
    yield* Migrator.make({})({
      loader: Migrator.fromRecord(
        Object.fromEntries(
          names.map((name, index) => [`${61 + index}_${name}`, byName.get(name)!]),
        ),
      ),
    });
  });

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const hasReviewGuides = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_review_guides'
  `;
  return tables.length === 1;
});

describe("GOAT migration ids", () => {
  it.effect("runs the upstream migration a GOAT ledger skipped and moves GOAT's ids up", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger([
        "ServerActivityIndexes",
        "RemoteReports",
        "RemoteDispatches",
        "ChannelLedger",
        "RemoteDispatchQuestions",
        "ThreadRunResults",
        "RemoteReportRelay",
      ]);
      assert.isFalse(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* runMigrations(), [[61, "PullRequestReviewGuides"]]);
      assert.isTrue(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("finishes the GOAT migrations a partial ledger had not reached yet", () =>
    Effect.gen(function* () {
      yield* seedGoatLedger(["ServerActivityIndexes", "RemoteReports", "RemoteDispatches"]);
      assert.deepStrictEqual(yield* runMigrations(), [
        [61, "PullRequestReviewGuides"],
        [65, "ChannelLedger"],
        [66, "RemoteDispatchQuestions"],
        [67, "ThreadRunResults"],
        [68, "RemoteReportRelay"],
      ]);
      assert.isTrue(yield* hasReviewGuides);
      assert.deepStrictEqual(yield* history, migrationManifest);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
