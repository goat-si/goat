import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "DatabaseMaintenance",
  (it) => {
    it.effect("reports an unreadable database as an inspection failure", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "goat-inspect-" }),
          "statev2.sqlite",
        );
        yield* fs.writeFileString(dbPath, "not a database");
        const failure = yield* Effect.flip(maintenance.inspect(dbPath));
        assert.equal(failure._tag, "DatabaseInspectError");
      }).pipe(Effect.scoped),
    );

    it.effect("reports and deletes only the database from before 0.1.0", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "goat-legacy-" });
        const dbPath = path.join(userdata, "statev2.sqlite");
        const legacy = path.join(userdata, "state.sqlite");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);

        const openLegacy = NodeSqliteClient.layer({ filename: legacy });
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`CREATE TABLE v1_data (value TEXT)`;
        }).pipe(Effect.provide(openLegacy));
        assert.isAbove((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes ?? 0, 0);

        // A version before 0.1.0 still running against it keeps it.
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM v1_data`;
          return yield* Effect.flip(maintenance.removeLegacyDatabase(dbPath));
        }).pipe(Effect.provide(openLegacy));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.isTrue(yield* fs.exists(legacy));

        yield* maintenance.removeLegacyDatabase(dbPath);
        assert.isFalse(yield* fs.exists(legacy));
        assert.isFalse(yield* fs.exists(`${legacy}-wal`));
        assert.isTrue(yield* fs.exists(dbPath));
        assert.isNull((yield* maintenance.inspect(dbPath)).legacyDatabaseBytes);
      }).pipe(Effect.scoped),
    );

    it.effect("compacts an existing database offline only once its server has stopped", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-compact-" });
        const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
        // A migrated database created before incremental auto_vacuum, with free pages.
        yield* Effect.flatMap(
          ProjectionMaintenance.ProjectionMaintenanceV2,
          (projections) => projections.rebuild,
        ).pipe(
          Effect.provide(
            ProjectionMaintenance.layer.pipe(
              Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
              Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA auto_vacuum = NONE`;
          yield* sql`VACUUM`;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          yield* sql`CREATE TABLE discarded_data (value BLOB)`;
          yield* sql`INSERT INTO discarded_data VALUES (zeroblob(4194304))`;
          yield* sql`DROP TABLE discarded_data`;
          yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

        // A server that merely has the database open, like an idle one, is enough to refuse.
        const sizeBefore = (yield* fs.stat(dbPath)).size;
        const refused = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT value FROM retained_data`;
          return yield* maintenance.compact(dbPath).pipe(Effect.flip);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.equal(refused._tag, "DatabaseInUseError");
        assert.equal((yield* fs.stat(dbPath)).size, sizeBefore);

        const result = yield* maintenance.compact(dbPath);
        // The 4 MiB of free pages are returned to the filesystem.
        assert.isBelow(result.afterBytes, result.beforeBytes - 3 * 1024 * 1024);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
          assert.deepEqual(yield* sql`SELECT value FROM retained_data`, [{ value: "keep" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })));
      }).pipe(Effect.scoped),
    );
  },
);

const createLegacyDatabase = (legacy: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`CREATE TABLE v1_data (value TEXT)`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: legacy })));

/**
 * Deletes files the way Windows does: a database that any SQLite connection
 * holds, this process's own included, cannot be deleted. `busyRemovals`
 * stands in for another process holding the file, and `busy` completes at the
 * first such refusal.
 */
interface WindowsFileState {
  busyRemovals: number;
  busyAttempts: number;
  busy: Deferred.Deferred<void>;
}

const windowsFileSystem = (state: WindowsFileState) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const busy = (target: string) =>
        PlatformError.systemError({
          _tag: "Busy",
          module: "FileSystem",
          method: "remove",
          pathOrDescriptor: target,
        });
      const isOpen = (target: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`PRAGMA busy_timeout = 0`;
          yield* sql`BEGIN EXCLUSIVE`;
          yield* sql`ROLLBACK`;
        }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: target })),
          Effect.exit,
          Effect.map(Exit.isFailure),
        );
      return FileSystem.FileSystem.of({
        ...fs,
        remove: (target, options) =>
          Effect.gen(function* () {
            if (path.basename(target) === "state.sqlite") {
              if (state.busyRemovals > 0) {
                state.busyRemovals--;
                state.busyAttempts++;
                yield* Deferred.succeed(state.busy, undefined);
                return yield* busy(target);
              }
              if (yield* isOpen(target)) return yield* busy(target);
            }
            return yield* fs.remove(target, options);
          }),
      });
    }),
  );

const windowsMaintenance = (state: WindowsFileState) =>
  DatabaseMaintenance.layerWith({
    busyRetry: Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 3 })),
  }).pipe(
    Layer.provide(windowsFileSystem(state)),
    Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
    Layer.provideMerge(NodeServices.layer),
  );

describe("DatabaseMaintenance where an open file cannot be deleted", () => {
  it.effect("releases its own lock before deleting the database from before 0.1.0", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "goat-legacy-win-" });
      const legacy = path.join(userdata, "state.sqlite");
      yield* createLegacyDatabase(legacy);

      yield* maintenance.removeLegacyDatabase(path.join(userdata, "statev2.sqlite"));
      assert.isFalse(yield* fs.exists(legacy));
      assert.isFalse(yield* fs.exists(`${legacy}-wal`));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        windowsMaintenance({ busyRemovals: 0, busyAttempts: 0, busy: Deferred.makeUnsafe() }),
      ),
    ),
  );

  it.effect("retries a busy delete, then reports the database in use and keeps it", () => {
    const state: WindowsFileState = {
      busyRemovals: Number.POSITIVE_INFINITY,
      busyAttempts: 0,
      busy: Deferred.makeUnsafe(),
    };
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
      const userdata = yield* fs.makeTempDirectoryScoped({ prefix: "goat-legacy-busy-" });
      const dbPath = path.join(userdata, "statev2.sqlite");
      const legacy = path.join(userdata, "state.sqlite");
      yield* createLegacyDatabase(legacy);

      const held = yield* maintenance
        .removeLegacyDatabase(dbPath)
        .pipe(Effect.flip, Effect.forkChild);
      // Retries sleep only after the first attempt's real file I/O.
      yield* Deferred.await(state.busy);
      yield* TestClock.adjust("1 minute");
      assert.equal((yield* Fiber.join(held))._tag, "DatabaseInUseError");
      assert.equal(state.busyAttempts, 4);
      assert.isTrue(yield* fs.exists(legacy));

      // Held only for moments, as by an antivirus scan.
      state.busyRemovals = 2;
      state.busy = Deferred.makeUnsafe();
      const released = yield* maintenance.removeLegacyDatabase(dbPath).pipe(Effect.forkChild);
      yield* Deferred.await(state.busy);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(released);
      assert.isFalse(yield* fs.exists(legacy));
    }).pipe(Effect.scoped, Effect.provide(windowsMaintenance(state)));
  });
});
