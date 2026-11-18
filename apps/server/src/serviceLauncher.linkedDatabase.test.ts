// @effect-diagnostics nodeBuiltinImport:off - reads the restored SQLite database the way the server would.
import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";

/** A symlinked WAL database: SQLite keeps -wal and -shm beside the link's target. */
const makeLinkedDatabase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-linked-db-" });
  const databasePath = path.join(root, "userdata", "state.sqlite");
  const databaseFile = path.join(root, "data", "actual.sqlite");
  yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
  yield* fs.makeDirectory(path.dirname(databaseFile), { recursive: true });
  yield* fs.symlink(databaseFile, databasePath);
  const seed = new NodeSqlite.DatabaseSync(databasePath);
  seed.exec(
    "PRAGMA journal_mode = wal; CREATE TABLE events (payload TEXT NOT NULL); INSERT INTO events VALUES ('seed');",
  );
  seed.close();
  return { root, databasePath, databaseFile };
});

/** Runs an update until the trial or restarted previous runtime exits. */
const runUpdate = (input: {
  readonly root: string;
  readonly databasePath: string;
  readonly activeOnStop: string;
  readonly trial: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(input.root, "runtime", "service-state.json");
    const childSource = `
import { DatabaseSync } from "node:sqlite";
const dbPath = ${JSON.stringify(input.databasePath)};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  ${input.trial}
} else if (context.update === undefined) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA wal_autocheckpoint = 0; INSERT INTO events VALUES ('served');");
  process.once("SIGTERM", () => {
    ${input.activeOnStop}
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
    for (const version of ["1.0.0", "1.1.0"]) {
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(input.root, "runtime", "goat", "versions", version),
        childSource,
      );
    }
    yield* Effect.promise(() =>
      writeServiceState(statePath, { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.0.0" }),
    );
    const launcher = new Launcher(
      input.root,
      yield* Effect.promise(() => readServiceState(statePath)),
    );
    const outcome = yield* Effect.promise(() => launcher.run().catch(String));
    const state = yield* Effect.promise(() => readServiceState(statePath));
    return { outcome, state };
  });

const readEvents = (databasePath: string) => {
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const rows = db.prepare("SELECT payload FROM events ORDER BY rowid").all();
    return { integrity, payloads: rows.map((row) => row.payload) };
  } finally {
    db.close();
  }
};

it.layer(NodeServices.layer)("rollback of a symlinked database", (it) => {
  it.effect("preserves both copies when a failed trial changed the linked WAL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, databasePath, databaseFile } = yield* makeLinkedDatabase;
      const { outcome, state } = yield* runUpdate({
        root,
        databasePath,
        // A clean close checkpoints and removes the WAL, so the backup holds every write.
        activeOnStop: "db.close(); process.exit(0);",
        // The trial dies with its write still only in the WAL.
        trial:
          "const db = new DatabaseSync(dbPath); db.exec(\"PRAGMA wal_autocheckpoint = 0; INSERT INTO events VALUES ('trial');\"); process.exit(1);",
      });
      assert.include(String(outcome), "Database recovery required");
      assert.equal(state.update?.status, "pending");
      assert.isTrue(yield* fs.exists(`${databaseFile}-wal`));
      assert.deepEqual(readEvents(databasePath), {
        integrity: "ok",
        payloads: ["seed", "served", "trial"],
      });
      const path = yield* Path.Path;
      assert.isDefined(state.update?.id);
      const snapshot = path.join(root, "runtime", "db-backup", state.update.id, "database");
      assert.deepEqual(readEvents(snapshot), { integrity: "ok", payloads: ["seed", "served"] });
    }),
  );

  it.effect("keeps writes the server left in the WAL beside the link's target", () =>
    Effect.gen(function* () {
      const { root, databasePath } = yield* makeLinkedDatabase;
      const { outcome, state } = yield* runUpdate({
        root,
        databasePath,
        // Exiting without a close leaves the committed 'served' row only in the WAL.
        activeOnStop: "process.exit(0);",
        trial: "process.exit(1);",
      });
      assert.include(String(outcome), "Active child exited unexpectedly");
      assert.equal(state.update?.status, "rolled-back");
      assert.deepEqual(readEvents(databasePath), { integrity: "ok", payloads: ["seed", "served"] });
    }),
  );
});
