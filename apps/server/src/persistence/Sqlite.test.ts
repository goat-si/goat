// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { migrationManifest } from "./Migrations.ts";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";

import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Runtime from "effect/Runtime";
import { makeCommandGate } from "../serverRuntimeStartup.ts";
import * as PersistenceOwner from "./PersistenceRecoveryOwner.ts";

import * as SqlitePersistence from "./Sqlite.ts";

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("runs file database opening and migration SQL away from the server thread", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-writer-migration-" });
    const dbPath = path.join(directory, "state.sqlite");
    let nativeCalls = 0;
    using _prepare = vi
      .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
      .mockImplementation(() => {
        nativeCalls++;
        throw new Error("Main-thread SQLite must not run in worker persistence mode");
      });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const applied = yield* sql<{ migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1`;
      assert.isAbove(migrationManifest.length, 0);
      const migrationHead = Math.max(...migrationManifest.map(([id]) => id));
      assert.equal(applied[0]?.migration_id, migrationHead);
      yield* sql`CREATE TABLE writer_roundtrip(value TEXT)`;
      yield* sql`INSERT INTO writer_roundtrip VALUES ('kept')`;
      assert.deepEqual(yield* sql`SELECT value FROM writer_roundtrip`, [{ value: "kept" }]);
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
    assert.equal(nativeCalls, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import * as NodeWorkerThreads from "node:worker_threads";

it.effect("publishes one fatal notification after a lost COMMIT without replaying it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-fatal-writer-" });
    const filename = path.join(directory, "state.sqlite");
    const workers: Array<NodeWorkerThreads.Worker> = [];
    let commitId: number | undefined;
    let notifications = 0;
    const original = NodeWorkerThreads.Worker.prototype.postMessage;
    using _capture = vi
      .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
      .mockImplementation(function (this: NodeWorkerThreads.Worker, message, ...rest) {
        if (!workers.includes(this)) workers.push(this);
        if (typeof message?.sql === "string" && /^\s*COMMIT\b/i.test(message.sql))
          commitId = message.id;
        return original.call(this, message, ...rest);
      });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE fatal_probe(value INTEGER)`;
      assert.equal((yield* sql`SELECT missing_function()`.pipe(Effect.flip))._tag, "SqlError");
      assert.equal(notifications, 0, "an ordinary SQL error is not fatal");
      const writer = workers[0]!;
      const committed = yield* Deferred.make<void>();
      const emit = writer.emit.bind(writer);
      using _loseReply = vi.spyOn(writer, "emit").mockImplementation((event, ...args) => {
        if (event === "message" && args[0]?.id === commitId && commitId !== undefined) {
          Deferred.doneUnsafe(committed, Effect.void);
          return true;
        }
        return emit(event, ...args);
      });
      const transaction = yield* sql
        .withTransaction(sql`INSERT INTO fatal_probe VALUES (1)`)
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(committed);
      writer.emit("error", new Error("writer failed after COMMIT"));
      writer.emit("error", new Error("duplicate writer error"));
      yield* Effect.promise(() => writer.terminate());
      assert.equal((yield* Fiber.join(transaction))._tag, "Failure");
      assert.equal(
        (yield* sql`INSERT INTO fatal_probe VALUES (2)`.pipe(Effect.exit))._tag,
        "Failure",
      );
      const independent = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      try {
        assert.equal(
          independent.prepare("SELECT COUNT(*) AS count FROM fatal_probe").get()?.count,
          1,
        );
      } finally {
        independent.close();
      }
      assert.equal(workers.length, 1, "a failed writer must never be replaced in place");
      assert.equal(notifications, 1, "permanent writer failure must reach its lifetime owner");
      assert.equal(notifications, 1, "error and exit belong to one fatal epoch");
    }).pipe(
      Effect.provide(
        NodeSqliteClient.layer({
          filename,
          writerWorker: true,
          onFatalPersistence: () => {
            notifications++;
          },
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "fatal persistence rejects queued and future work (ready=%s)",
  (ready) =>
    Effect.gen(function* () {
      const captured =
        yield* Deferred.make<
          NonNullable<Context.Service.Shape<typeof PersistenceOwner.PersistenceRecoveryOwner>>
        >();
      const exits: Array<number> = [];
      let alarms = 0;
      let mutations = 0;
      const lifetime = yield* PersistenceOwner.run(
        Effect.gen(function* () {
          const owner = yield* PersistenceOwner.PersistenceRecoveryOwner;
          assert.isDefined(owner);
          yield* Deferred.succeed(captured, owner!);
          return yield* Effect.never;
        }),
        {
          armHardExit: () => {
            alarms++;
          },
          exit: (code) => {
            exits.push(code);
          },
        },
      ).pipe(Effect.exit, Effect.forkChild);
      const owner = yield* Deferred.await(captured);
      const gate = yield* makeCommandGate.pipe(
        Effect.provideService(PersistenceOwner.PersistenceRecoveryOwner, owner),
      );
      if (ready) yield* gate.signalCommandReady;
      const queued = ready
        ? undefined
        : yield* gate
            .enqueueCommand(
              Effect.sync(() => {
                mutations++;
              }),
            )
            .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      owner.report(new Error("writer lost"));
      owner.report(new Error("duplicate exit"));
      yield* gate.signalCommandReady;
      if (queued !== undefined) assert.isTrue(Exit.isFailure(yield* Fiber.join(queued)));
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            gate.enqueueCommand(
              Effect.sync(() => {
                mutations++;
              }),
            ),
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(yield* Effect.exit(gate.awaitCommandReady)));
      assert.equal(mutations, 0);
      const result = yield* Fiber.join(lifetime);
      const codes: Array<number> = [];
      Runtime.defaultTeardown(result, (code) => codes.push(code));
      assert.deepEqual(codes, [80]);
      assert.deepEqual(exits, [80]);
      assert.equal(alarms, 1);
    }).pipe(Effect.scoped),
);

it.effect(
  "intentional writer retirement and ordinary startup refusal leave the owner healthy",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-owner-close-" });
      const exits: Array<number> = [];
      let alarms = 0;
      const boundary = {
        armHardExit: () => {
          alarms++;
        },
        exit: (code: number) => {
          exits.push(code);
        },
      };
      yield* PersistenceOwner.run(
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`SELECT 1`;
          }).pipe(
            Effect.provide(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
          );
          const owner = yield* PersistenceOwner.PersistenceRecoveryOwner;
          yield* owner!.check;
        }),
        boundary,
      );
      const refused = yield* PersistenceOwner.run(
        Layer.build(SqlitePersistence.layerFromPath(directory)),
        boundary,
      ).pipe(Effect.scoped, Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.equal(alarms, 0);
      assert.deepEqual(exits, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("writer failure during SQLite layer construction reaches the server lifetime owner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-owner-build-" });
    let alarms = 0;
    let injected = false;
    const exits: Array<number> = [];
    const original = NodeWorkerThreads.Worker.prototype.postMessage;
    using _inject = vi
      .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
      .mockImplementation(function (this: NodeWorkerThreads.Worker, message, ...rest) {
        if (!injected && typeof message?.sql === "string" && message.sql.includes("busy_timeout")) {
          injected = true;
          this.emit("error", new Error("writer failed before migrations"));
          return;
        }
        return original.call(this, message, ...rest);
      });
    const result = yield* PersistenceOwner.run(
      Layer.build(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      {
        armHardExit: () => {
          alarms++;
        },
        exit: (code) => {
          exits.push(code);
        },
      },
    ).pipe(Effect.scoped, Effect.exit);
    assert.isTrue(injected);
    assert.isTrue(Exit.isFailure(result));
    assert.equal(alarms, 1);
    assert.deepEqual(exits, [80]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fatal construction arms an exit independent of stuck application finalizers", () =>
  Effect.gen(function* () {
    const finalizing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let expire: (() => void) | undefined;
    let constructions = 0;
    const exits: Array<number> = [];
    const lifetime = yield* PersistenceOwner.run(
      Effect.gen(function* () {
        constructions++;
        const owner = yield* PersistenceOwner.PersistenceRecoveryOwner;
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(finalizing, undefined).pipe(Effect.andThen(Deferred.await(release))),
        );
        owner!.report(new Error("writer failed during construction"));
        return yield* Effect.never;
      }),
      {
        armHardExit: (alarm) => {
          expire = alarm;
        },
        exit: (code) => {
          exits.push(code);
        },
      },
    ).pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(finalizing);
    assert.isUndefined(lifetime.pollUnsafe());
    assert.deepEqual(exits, []);
    assert.isDefined(expire);
    expire!();
    assert.deepEqual(exits, [80]);
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(lifetime)));
    assert.equal(constructions, 1);
    assert.deepEqual(exits, [80, 80]);
  }).pipe(Effect.scoped),
);

it.effect("does not receipt a failed worker migration and reopens safely", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-failed-migration-" });
    const filename = path.join(directory, "state.sqlite");
    const receipts = () => {
      const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
      try {
        if (
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'effect_sql_migrations'").get() ===
          undefined
        )
          return undefined;
        return Number(
          db.prepare("SELECT COUNT(*) AS count FROM effect_sql_migrations").get()?.count,
        );
      } finally {
        db.close();
      }
    };
    let before: number | undefined;
    const original = NodeWorkerThreads.Worker.prototype.postMessage;
    using injecting = vi
      .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
      .mockImplementation(function (this: NodeWorkerThreads.Worker, message, ...rest) {
        if (
          before === undefined &&
          typeof message === "object" &&
          message !== null &&
          "sql" in message &&
          typeof message.sql === "string" &&
          /^\s*CREATE\s+TABLE\b/i.test(message.sql) &&
          !message.sql.includes("effect_sql_migrations")
        ) {
          before = receipts();
          if (before !== undefined)
            return original.call(
              this,
              { ...message, sql: "SELECT deliberately_missing_migration_function()" },
              ...rest,
            );
        }
        return original.call(this, message, ...rest);
      });
    const failed = yield* Layer.build(SqlitePersistence.layerFromPath(filename)).pipe(
      Effect.scoped,
      Effect.exit,
    );
    assert.equal(failed._tag, "Failure");
    assert.isNumber(before);
    assert.equal(receipts(), before);
    injecting.mockRestore();
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`)[0]?.id,
        Math.max(...migrationManifest.map(([id]) => id)),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(filename)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("prunes expired computer use history when the database opens", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-history-prune-" });
    const dbPath = path.join(dir, "state.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO computer_use_input_history
        (thread_id, recorded_at, target_kind, tab_host, method, verdict)
        VALUES ('thread:a', 0, 'tab', 'example.test', 'click', 'sent')`;
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
    yield* TestClock.adjust("31 days");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`SELECT id FROM computer_use_input_history`, []);
    }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
