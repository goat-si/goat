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

const isDatabaseNewerThanBuildError = Schema.is(DatabaseNewerThanBuildError);

const displacedGoatId = Math.max(...migrationEntries.map(([id]) => id)) + 100;

describe("runMigrations database ahead of this build", () => {
  it.effect(
    "fails with DatabaseNewerThanBuildError when a newer build recorded an unknown migration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 60 });
        // ServerActivityIndexes belongs at 68. A newer build already recorded
        // its own migration on that id, so reconciliation cannot move it.
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (61, 'ServerActivityIndexes')
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (69, 'FutureUpstreamMigration')
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
