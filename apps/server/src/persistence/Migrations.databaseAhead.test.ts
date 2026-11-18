import { SERVER_EXIT_CODE_DATABASE_AHEAD } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import packageJson from "../../package.json" with { type: "json" };
import { DatabaseNewerThanBuildError } from "./Errors.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";
import { assertMemoryMigrationsCompatible } from "./reconcileGoatMigrationIds.ts";

const isDatabaseNewerThanBuildError = Schema.is(DatabaseNewerThanBuildError);

const displacedGoatId = Math.max(...migrationEntries.map(([id]) => id)) + 100;

describe("runMigrations database ahead of this build", () => {
  it.effect(
    "fails with DatabaseNewerThanBuildError when a newer build recorded an unknown migration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        // ServerActivityIndexes belongs at 90. A newer build already recorded
        // its own migration on that id, so reconciliation cannot move it.
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (61, 'ServerActivityIndexes')
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (90, 'FutureUpstreamMigration')
        `;

        const exit = yield* Effect.exit(runMigrations());
        assert.strictEqual(exit._tag, "Failure");
        if (exit._tag !== "Failure") return;
        const failure = Cause.squash(exit.cause);
        assert.strictEqual(SERVER_EXIT_CODE_DATABASE_AHEAD, 79);
        assert.strictEqual(Runtime.getErrorExitCode(failure), SERVER_EXIT_CODE_DATABASE_AHEAD);
        assert.isTrue(isDatabaseNewerThanBuildError(failure));
        if (!isDatabaseNewerThanBuildError(failure)) return;
        assert.deepStrictEqual(failure.unknownMigrations, ["FutureUpstreamMigration"]);
        assert.strictEqual(
          failure.originalMessage,
          "Cannot move GOAT migrations onto ids another migration recorded.",
        );
        assert.strictEqual(failure[Runtime.errorExitCode], 79);
        assert.strictEqual(
          failure.message,
          `This database was upgraded by a newer GOAT build; GOAT ${packageJson.version} cannot open it. Start that newer build, or update GOAT. Unknown migrations: FutureUpstreamMigration.`,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("the 158 build refuses a migrated 159 memory database", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* runMigrations({ toMigrationInclusive: 159 })).at(-1), [
        159,
        "MemoryThreadLineage",
      ]);
      const manifest158 = migrationEntries.filter(([id]) => id <= 158);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest158));
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag !== "MigrationError") return;
      assert.strictEqual(failure.kind, "BadState");
      assert.include(failure.message, "Unreleased memory DB is incompatible");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("the 160 build refuses a migrated 161 hub floor database", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* runMigrations({ toMigrationInclusive: 161 })).at(-1), [
        161,
        "MemoryHubFloor",
      ]);
      const manifest160 = migrationEntries.filter(([id]) => id <= 160);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest160));
      assert.strictEqual(failure._tag, "MigrationError");
      assert.include(failure.message, "Unreleased memory DB is incompatible");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("the 161 build refuses a migrated scope-version database", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* runMigrations({ toMigrationInclusive: 162 })).at(-1), [
        162,
        "MemoryScopeVersion",
      ]);
      const manifest161 = migrationEntries.filter(([id]) => id <= 161);
      const failure = yield* Effect.flip(assertMemoryMigrationsCompatible(manifest161));
      assert.strictEqual(failure._tag, "MigrationError");
      assert.include(failure.message, "Unreleased memory DB is incompatible");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("repairs only the kind byte of historical compact move receipts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 162 });
      yield* sql`INSERT INTO memory_compact_receipts
        (space,operation_id,operation_digest,hub_sequence,receipt_json,compact_json,compact_blob)
        VALUES
          ('synthetic','old-move','d',1,'{}','{"operationKind":"move"}',X'02FF0000AFFE00'),
          ('synthetic','old-upsert','d',2,'{}','{"operationKind":"upsert"}',X'02000000AFFE00'),
          ('synthetic','new-move','d',3,'{}','{"operationKind":"move"}',X'02040300AFFE00')`;
      yield* runMigrations();
      assert.deepStrictEqual(
        yield* sql`SELECT operation_id,hex(compact_blob) AS binary FROM memory_compact_receipts ORDER BY hub_sequence`,
        [
          { operation_id: "old-move", binary: "02040000AFFE00" },
          { operation_id: "old-upsert", binary: "02000000AFFE00" },
          { operation_id: "new-move", binary: "02040300AFFE00" },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "migration 161 preserves suggestion forget generations and backfills the hub watermark",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 160 });
        yield* sql`INSERT INTO memory_space_counters(space,forget_generation) VALUES ('synthetic',7)`;
        yield* sql`INSERT INTO memory_hub_retention(space,checkpoint_sequence) VALUES ('synthetic',11)`;
        assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 161 }), [
          [161, "MemoryHubFloor"],
        ]);
        assert.deepStrictEqual(
          yield* sql`SELECT forget_generation,last_forget_sequence FROM memory_space_counters WHERE space='synthetic'`,
          [{ forget_generation: 7, last_forget_sequence: 11 }],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps MigrationError when a failing ledger only contains known names", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'ThreadFailureLookupIndex'
        WHERE migration_id = 61
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${displacedGoatId}, 'ServerActivityIndexes')
      `;

      const failure = yield* Effect.flip(runMigrations());
      assert.strictEqual(failure._tag, "MigrationError");
      if (failure._tag !== "MigrationError") return;
      assert.strictEqual(failure.kind, "BadState");
      assert.strictEqual(
        failure.message,
        "Migration 61 is recorded as ThreadFailureLookupIndex, expected PullRequestReviewGuides.",
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
