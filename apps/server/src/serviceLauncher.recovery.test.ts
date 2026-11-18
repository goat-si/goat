// @effect-diagnostics nodeBuiltinImport:off -- Recovery fixtures use real SQLite file sets.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";

const lockModule = JSON.stringify(new URL("./serverOwnerLockFile.ts", import.meta.url).href);

const fixture = (trial: string, previousAction = "") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-launcher-recovery-" });
    const runtime = path.join(root, "runtime");
    const statePath = path.join(runtime, "service-state.json");
    const dbPath = path.join(root, "userdata", "statev2.sqlite");
    const backupDir = path.join(runtime, "db-backup", "recovery");
    const previousStarted = path.join(root, "previous-started");
    const stateDir = path.dirname(dbPath);
    yield* fs.makeDirectory(stateDir);
    {
      using db = new NodeSqlite.DatabaseSync(dbPath);
      db.exec("CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('before trial')");
    }
    const baseline = yield* fs.readFile(dbPath);
    const state = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "recovery",
        status: "pending" as const,
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        dbPath,
      },
    };
    const previous = `import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const dbPath = ${JSON.stringify(dbPath)};
writeFileSync(${JSON.stringify(previousStarted)}, "");
${previousAction}
process.exit(0);`;
    yield* writeFakeRuntime(fs, path, path.join(runtime, "goat", "versions", "1.0.0"), previous);
    yield* writeFakeRuntime(
      fs,
      path,
      path.join(runtime, "goat", "versions", "1.1.0"),
      `
import { renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tryAcquireServerOwnerLock } from ${lockModule};
const dbPath = ${JSON.stringify(dbPath)};
const stateDir = ${JSON.stringify(stateDir)};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
${trial}
`,
    );
    yield* Effect.promise(() => writeServiceState(statePath, state));
    const run = () => Effect.promise(() => new Launcher(root, state).run().catch(String));
    return {
      fs,
      path,
      runtime,
      statePath,
      state,
      dbPath,
      backupDir,
      previousStarted,
      baseline,
      run,
    };
  });

const legacyWrite = `
const legacy = new DatabaseSync(join(stateDir, "server-owner.sqlite"));
legacy.exec("BEGIN EXCLUSIVE");
const db = new DatabaseSync(dbPath);
db.exec("INSERT INTO messages VALUES ('legacy write')");
db.close();
legacy.close();
`;

const expectBlocked = (f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    assert.include(String(yield* f.run()), "Database recovery required");
    assert.isFalse(yield* f.fs.exists(f.previousStarted));
    assert.deepEqual(yield* Effect.promise(() => readServiceState(f.statePath)), f.state);
  });

it.layer(NodeServices.layer)("conservative launcher recovery", (it) => {
  it.effect("blocks a recreated generation log with the same generation and owner tag", () =>
    Effect.gen(function* () {
      const f = yield* fixture(`
const logPath = join(stateDir, "server-owner.lock");
const old = new DatabaseSync(logPath, { readOnly: true });
const { owner } = old.prepare("SELECT owner FROM owner_generations WHERE generation = 1").get();
old.close();
unlinkSync(logPath);
tryAcquireServerOwnerLock(stateDir, owner).release();
process.exit(1);
`);
      yield* expectBlocked(f);
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.backupDir, "database")), f.baseline);
    }),
  );

  it.effect("blocks a SQLite-only legacy owner that wrote and exited before rollback", () =>
    Effect.gen(function* () {
      const f = yield* fixture(legacyWrite + "process.exit(1);");
      yield* expectBlocked(f);
      using db = new NodeSqlite.DatabaseSync(f.dbPath, { readOnly: true });
      assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get()?.count, 2);
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.backupDir, "database")), f.baseline);
    }),
  );

  it.effect("blocks a missing backup directory after an interrupted copy", () =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      // The external phase survives the loss of the backup directory and its old markers.
      yield* f.fs.writeFileString(f.path.join(f.runtime, "db-update-recovery.phase"), "restore\n");
      yield* expectBlocked(f);
      assert.isFalse(yield* f.fs.exists(f.backupDir));
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
    }),
  );

  it.effect("blocks a missing backup directory after the trial phase was recorded", () =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      yield* f.fs.writeFileString(f.path.join(f.runtime, "db-update-recovery.phase"), "trial\n");
      yield* expectBlocked(f);
      assert.isFalse(yield* f.fs.exists(f.backupDir));
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
    }),
  );

  it.effect.each([
    ["a resumed trial", "trial\n", undefined],
    ["a resumed restore", "restore\n", undefined],
    ["a legacy restore marker", undefined, ".restore-pending"],
    ["a legacy rollback marker", undefined, ".rollback-pending"],
    ["an unreadable phase value", "unexpected\n", undefined],
  ] as const)("blocks %s even with two intact copies", ([_name, phase, oldMarker]) =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      yield* f.fs.makeDirectory(f.backupDir, { recursive: true });
      const snapshot = f.path.join(f.backupDir, "database");
      yield* f.fs.copyFile(f.dbPath, snapshot);
      if (phase !== undefined) {
        yield* f.fs.writeFileString(f.path.join(f.runtime, "db-update-recovery.phase"), phase);
      }
      if (oldMarker !== undefined) {
        yield* f.fs.writeFileString(f.path.join(f.backupDir, oldMarker), "");
      }
      yield* expectBlocked(f);
      yield* expectBlocked(f);
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
      assert.deepEqual(yield* f.fs.readFile(snapshot), f.baseline);
    }),
  );

  it.effect.each([
    ["a lost generation log", 'unlinkSync(join(stateDir, "server-owner.lock"));'],
    [
      "a missing snapshot in the same launcher",
      'renameSync(join(stateDir, "../runtime/db-backup/recovery/database"), join(stateDir, "saved"));',
    ],
    [
      "a foreign owner even without any writes",
      'tryAcquireServerOwnerLock(stateDir, "desktop").release();',
    ],
  ] as const)("blocks %s", ([_name, action]) =>
    Effect.gen(function* () {
      const f = yield* fixture(`${action}\nprocess.exit(1);`);
      yield* expectBlocked(f);
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
      if (_name !== "a missing snapshot in the same launcher") {
        assert.deepEqual(yield* f.fs.readFile(f.path.join(f.backupDir, "database")), f.baseline);
      }
    }),
  );

  it.effect("blocks truncated live data with foreign history before any restore marker", () =>
    Effect.gen(function* () {
      const f = yield* fixture(`
tryAcquireServerOwnerLock(stateDir, "desktop").release();
writeFileSync(dbPath, "truncated");
process.exit(1);
`);
      yield* expectBlocked(f);
      assert.equal(yield* f.fs.readFileString(f.dbPath), "truncated");
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.backupDir, "database")), f.baseline);
    }),
  );

  it.effect("does not roll back a tracked trial with truncated live data", () =>
    Effect.gen(function* () {
      const f = yield* fixture(`
tryAcquireServerOwnerLock(stateDir, "service-trial:" + context.update.id).release();
writeFileSync(dbPath, "truncated");
process.exit(1);
`);
      yield* expectBlocked(f);
      assert.equal(yield* f.fs.readFileString(f.dbPath), "truncated");
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.backupDir, "database")), f.baseline);
    }),
  );

  it.effect("does not accept identical but unusable SQLite files as a safe restore", () =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      yield* f.fs.truncate(f.dbPath, 1024);
      const truncated = yield* f.fs.readFile(f.dbPath);
      yield* expectBlocked(f);
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), truncated);
      assert.deepEqual(yield* f.fs.readFile(f.path.join(f.backupDir, "database")), truncated);
    }),
  );

  it.effect("keeps a verified database when the target is missing before any trial", () =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      yield* f.fs.remove(f.path.join(f.runtime, "goat", "versions", "1.1.0", ".install-complete"));
      assert.include(String(yield* f.run()), "Active child exited unexpectedly");
      assert.isTrue(yield* f.fs.exists(f.previousStarted));
      assert.isFalse(yield* f.fs.exists(f.backupDir));
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
    }),
  );

  it.effect("blocks an unusable database even when the target is missing before any trial", () =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      yield* f.fs.remove(f.path.join(f.runtime, "goat", "versions", "1.1.0", ".install-complete"));
      yield* f.fs.truncate(f.dbPath, 1024);
      yield* expectBlocked(f);
      assert.isFalse(yield* f.fs.exists(f.backupDir));
    }),
  );

  it.effect("checks the live file set after manual acknowledgement and retains the snapshot", () =>
    Effect.gen(function* () {
      const f = yield* fixture("process.exit(1);");
      yield* f.fs.makeDirectory(f.backupDir, { recursive: true });
      const snapshot = f.path.join(f.backupDir, "database");
      yield* f.fs.copyFile(f.dbPath, snapshot);
      yield* f.fs.writeFileString(
        f.path.join(f.runtime, "db-update-recovery.phase"),
        "keep-live\n",
      );
      yield* f.fs.writeFileString(f.dbPath + "-wal", "truncated");
      yield* expectBlocked(f);
      assert.equal(yield* f.fs.readFileString(f.dbPath + "-wal"), "truncated");
      yield* f.fs.remove(f.dbPath + "-wal");
      assert.include(String(yield* f.run()), "Active child exited unexpectedly");
      assert.isTrue(yield* f.fs.exists(f.previousStarted));
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.baseline);
      assert.deepEqual(yield* f.fs.readFile(snapshot), f.baseline);
    }),
  );

  it.effect.each(["header checksum", "frame salt", "frame checksum"] as const)(
    "blocks a full-length WAL with a bad %s after manual acknowledgement",
    (damage) =>
      Effect.gen(function* () {
        const f = yield* fixture(
          "process.exit(1);",
          'const db = new DatabaseSync(dbPath); db.prepare("SELECT * FROM messages").all(); db.close();',
        );
        const walPath = f.dbPath + "-wal";
        let main: Uint8Array;
        let validWal: Buffer;
        {
          using db = new NodeSqlite.DatabaseSync(f.dbPath);
          db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
          main = yield* f.fs.readFile(f.dbPath);
          db.exec("INSERT INTO messages VALUES ('first commit');");
          db.exec("INSERT INTO messages VALUES ('second commit');");
          validWal = Buffer.from(yield* f.fs.readFile(walPath));
        }
        const frameSize = 24 + validWal.readUInt32BE(8);
        const lastFrame = validWal.length - frameSize;
        assert.isAbove(lastFrame, 32);
        assert.isAbove(validWal.readUInt32BE(lastFrame + 4), 0);
        const damaged = Buffer.from(validWal);
        const offset = {
          "header checksum": 24,
          "frame salt": lastFrame + 8,
          "frame checksum": lastFrame + 24,
        }[damage];
        damaged.writeUInt8(damaged.readUInt8(offset) ^ 1, offset);
        yield* f.fs.writeFile(f.dbPath, main);
        yield* f.fs.writeFile(walPath, damaged);
        yield* f.fs.writeFileString(
          f.path.join(f.runtime, "db-update-recovery.phase"),
          "keep-live\n",
        );
        yield* expectBlocked(f);
        assert.deepEqual(yield* f.fs.readFile(f.dbPath), main);
        assert.deepEqual(Buffer.from(yield* f.fs.readFile(walPath)), damaged);

        yield* f.fs.writeFile(walPath, validWal);
        assert.include(String(yield* f.run()), "Active child exited unexpectedly");
        assert.isTrue(yield* f.fs.exists(f.previousStarted));
        using db = new NodeSqlite.DatabaseSync(f.dbPath, { readOnly: true });
        assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get()?.count, 3);
      }),
  );
});
