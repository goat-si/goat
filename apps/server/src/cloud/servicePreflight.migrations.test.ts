// @effect-diagnostics nodeBuiltinImport:off - fixtures are SQLite files the preflight opens read-only.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import { GOAT_MIGRATION_NAMES } from "../persistence/reconcileGoatMigrationIds.ts";
import { FIXTURE_LEDGER_GOAT_END } from "../persistence/reconcileGoatMigrationIds.testkit.ts";
import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const upstream = migrationManifest.filter(([, name]) => !GOAT_MIGRATION_NAMES.has(name));
const goatNames = migrationManifest.flatMap(([id, name]) =>
  GOAT_MIGRATION_NAMES.has(name) && id <= FIXTURE_LEDGER_GOAT_END ? [name] : [],
);

const writeLedger = (databasePath: string, rows: ReadonlyArray<readonly [number, string]>) => {
  const db = new NodeSqlite.DatabaseSync(databasePath);
  db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)");
  const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
  for (const [id, name] of rows) insert.run(id, name);
  db.close();
};

it.layer(NodeServices.layer)("service preflight migration history", (it) => {
  const preflight = (rows: ReadonlyArray<readonly [number, string]> | "garbage" | "missing") =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-preflight-" });
      const databasePath = path.join(root, "state.sqlite");
      if (rows === "garbage") yield* fs.writeFileString(databasePath, "not a database");
      else if (rows !== "missing") writeLedger(databasePath, rows);
      return runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "9.8.7",
      });
    });
  const reason = (result: ReturnType<typeof runServicePreflight>) =>
    result.status === "blocked" ? result.reason : "";

  it.effect("accepts a fresh home and this build's own ledger", () =>
    Effect.gen(function* () {
      assert.equal((yield* preflight("missing")).status, "ready");
      assert.equal((yield* preflight(migrationManifest)).status, "ready");
    }),
  );

  it.effect("accepts a released GOAT ledger that startup moves to its current ids", () =>
    Effect.gen(function* () {
      const released = [
        ...upstream.filter(([id]) => id < 61),
        ...goatNames.map((name, index) => [61 + index, name] as const),
      ];
      assert.equal((yield* preflight(released)).status, "ready");
    }),
  );

  it.effect("accepts a V2 preview ledger that startup reconciles", () =>
    Effect.gen(function* () {
      const preview = [
        ...migrationManifest.filter(([id]) => id < 53),
        [53, "PullRequestFilesViewed"],
        [54, "OrchestrationV2"],
        [55, "RemoveRedundantProjectionIndexes"],
      ] as const;
      assert.equal((yield* preflight(preview)).status, "ready");
    }),
  );

  it.effect.each([176, 177, 178])("accepts the bot attention preview recorded at %s", (id) =>
    Effect.gen(function* () {
      const preview = [
        ...migrationManifest.filter(([migrationId]) => migrationId < id),
        [id, "ChannelBotAttention"],
      ] as const;
      const result = yield* preflight(preview);
      assert.equal(result.status, "ready", reason(result));
    }),
  );

  it.effect("blocks a database a newer build wrote, naming its migrations", () =>
    Effect.gen(function* () {
      const result = yield* preflight([...migrationManifest, [100_000, "FutureMigration"]]);
      assert.equal(result.status, "blocked");
      assert.include(reason(result), "goat@9.8.7 does not know: FutureMigration");
    }),
  );

  it.effect("blocks a history whose recorded ids would skip a migration", () =>
    Effect.gen(function* () {
      const skippedId = upstream.find(([id]) => id >= 60)![0];
      const result = yield* preflight(migrationManifest.filter(([id]) => id !== skippedId));
      assert.equal(result.status, "blocked");
      assert.include(reason(result), "would skip required schema migrations");
    }),
  );

  it.effect("blocks a database it cannot read", () =>
    Effect.gen(function* () {
      const result = yield* preflight("garbage");
      assert.equal(result.status, "blocked");
      assert.include(reason(result), "Could not read this database");
    }),
  );

  it.effect("blocks a mixed-offset memory ledger that startup also refuses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-preflight-" });
      const databasePath = path.join(root, "state.sqlite");
      const misplacedId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
      writeLedger(
        databasePath,
        migrationManifest.map(([id, name]) => [name === "Memory" ? misplacedId : id, name]),
      );
      const startup = yield* runMigrations().pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
        Effect.flip,
      );
      assert.include(startup.message, "Unreleased memory DB is incompatible");
      const result = runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "9.8.7",
      });
      assert.equal(result.status, "blocked");
      assert.include(reason(result), "Unreleased memory DB is incompatible");
    }),
  );

  it.effect("blocks unreleased memory tables when no migration ledger exists", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-preflight-" });
      const databasePath = path.join(root, "state.sqlite");
      {
        using db = new NodeSqlite.DatabaseSync(databasePath);
        db.exec("CREATE TABLE memory_spaces (id INTEGER PRIMARY KEY)");
      }
      const result = runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "9.8.7",
      });
      assert.equal(result.status, "blocked");
      assert.include(reason(result), "Unreleased memory DB is incompatible");
    }),
  );
});
