import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";
import {
  compareExactServiceVersions,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";

it("accepts only exact semantic versions", () => {
  for (const version of ["0.0.0", "1.2.3", "1.2.3-alpha.1", "1.2.3-0", "1.2.3+001"]) {
    assert.isTrue(isExactServiceVersion(version), version);
  }
  for (const version of ["latest", "01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+."]) {
    assert.isFalse(isExactServiceVersion(version), version);
  }
});

it("orders exact semantic versions without treating build metadata as precedence", () => {
  assert.equal(compareExactServiceVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareExactServiceVersions("1.2.4", "1.2.3"), 1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.1", "2.0.0-alpha.2"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha.2", "2.0.0-alpha.beta"), -1);
  assert.equal(compareExactServiceVersions("2.0.0-alpha-beta", "2.0.0-alpha-alpha"), 1);
  assert.equal(compareExactServiceVersions("2.0.0", "2.0.0-rc.1"), 1);
  assert.equal(compareExactServiceVersions("2.0.0+one", "2.0.0+two"), 0);
});

it("rejects contradictory service state", () => {
  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "0.0.31",
      update: {
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.32",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-3",
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "pending",
      },
    }),
  );

  assert.isUndefined(
    decodeServiceState({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      activeVersion: "1.0.0",
      update: {
        id: "update-2",
        fromVersion: "1.0.0",
        targetVersion: "0.9.0",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      },
    }),
  );
});

// Fake runtimes import the real lock helper, as a lock-aware server would.
const lockModuleUrl = JSON.stringify(
  NodeURL.pathToFileURL(NodeURL.fileURLToPath(new URL("./serverOwnerLockFile.ts", import.meta.url)))
    .href,
);

/** An active 1.0.0 that asks for 1.1.0, and a 1.1.0 trial running `trialSource`. */
const writeUpdateRuntimes = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  databasePath: string,
  trialSource: string,
) =>
  Effect.forEach(["1.0.0", "1.1.0"], (version) =>
    writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime", "goat", "versions", version),
      `
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
${trialSource}
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(databasePath)} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`,
    ),
  );

/** Runs a launcher until its restarted active child exits, which ends these scenarios. */
const runUntilActiveExits = (root: string, statePath: string) =>
  Effect.gen(function* () {
    const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
    yield* Effect.promise(() =>
      launcher.run().then(
        () => Promise.reject(new Error("launcher unexpectedly completed")),
        () => Promise.resolve(),
      ),
    );
    return yield* Effect.promise(() => readServiceState(statePath));
  });

// A pinned runtime is an executable at <versionDir>/t3. The tests stand one up
// as a Node shebang script so the launcher spawns it the way it spawns the
// real single-executable, IPC channel included.
const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, "goat");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    // Fixtures import TypeScript, which Node 22 runs only behind this flag.
    yield* fs.writeFileString(
      entryPath,
      `#!${process.execPath} --experimental-strip-types\n${childSource}`,
    );
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect("durably replaces and strictly reads one state document", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-test-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "0.0.31",
      } as const;

      yield* Effect.promise(() => writeServiceState(statePath, state));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);
    }),
  );

  it.effect("a fresh launcher clears a restart deferred by t3 update", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-restart-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const restartPending = path.join(root, "runtime", SERVICE_RESTART_PENDING_FILE);
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "goat", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const run = () =>
        Effect.gen(function* () {
          const launcher = new Launcher(
            root,
            yield* Effect.promise(() => readServiceState(statePath)),
          );
          const running = launcher.run();
          yield* Effect.promise(() => launcher.stop("SIGTERM"));
          yield* Effect.promise(() => running);
        });

      // A launcher that is still the old version leaves a marker that waits
      // for a newer one.
      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      // Whoever restarted the service, the launcher now runs what the unit
      // names, so the deferred-restart marker is gone.
      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect("serializes shutdown with launcher recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "goat", "versions", "1.0.0"),
        "setInterval(() => {}, 1_000);\n",
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      const running = launcher.run();
      const stopping = launcher.stop("SIGTERM");
      // An explicit stop leaves the marker that tells a child shutting down
      // mid-update that no replacement server is coming. It is present as
      // soon as stop() returns its promise, before queued transitions run.
      assert.isTrue(yield* fs.exists(path.join(root, "runtime", SERVICE_STOP_MARKER_FILE)));
      yield* Effect.promise(() => stopping);
      yield* Effect.promise(() => running);
    }),
  );

  it.effect("commits only after the trial reports prepared", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-flow-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: context.update.id });
  process.on("message", (message) => {
    if (message.type === "committed") process.exit(0);
  });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.1.0");
      assert.equal(state.update?.status, "committed");
    }),
  );

  it.effect("rolls back a trial that reports the wrong update ID", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "invalid-prepared",
      );
    }),
  );

  it.effect("restores the database when a migrating trial exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-db-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const original = "database before migration";
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, original);
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  // The trial's own ownership does not stand in the way of its rollback.
  tryAcquireServerOwnerLock(dirname(context.update.dbPath), "service-trial:" + context.update.id);
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  process.exit(1);
} else if (context.update === undefined) {
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${encodedDatabasePath} });
  setInterval(() => {}, 1_000);
} else {
  process.exit(0);
}
`;
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", version),
          childSource,
        );
      }
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(yield* fs.readFileString(databasePath), original);
      assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
      assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
      const updateId = state.update?.id;
      assert.isDefined(updateId);
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
    }),
  );

  it.effect("keeps a database another server wrote between the backup and the rollback", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-foreign-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      // The trial migrates, then a desktop server takes the data, writes and
      // exits before the trial fails.
      yield* writeUpdateRuntimes(
        fs,
        path,
        root,
        databasePath,
        `
  const lockDir = dirname(context.update.dbPath);
  tryAcquireServerOwnerLock(lockDir, "service-trial:" + context.update.id).release();
  writeFileSync(context.update.dbPath, "trial migration");
  tryAcquireServerOwnerLock(lockDir, "desktop").release();
  writeFileSync(context.update.dbPath, "desktop write");
  process.exit(1);`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );

      const state = yield* runUntilActiveExits(root, statePath);
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "rolled-back");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "candidate-exited:1;db-kept-for-other-server",
      );
      assert.equal(yield* fs.readFileString(databasePath), "desktop write");
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", state.update!.id)));
    }),
  );

  it.effect("neither backs up nor starts a trial while another server owns the userdata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-busy-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "desktop data");
      yield* writeUpdateRuntimes(
        fs,
        path,
        root,
        databasePath,
        `  writeFileSync(context.update.dbPath, "trial ran");
  process.exit(1);`,
      );
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      const desktop = yield* Effect.acquireRelease(
        Effect.sync(() => tryAcquireServerOwnerLock(path.dirname(databasePath), "desktop")),
        (lock) => Effect.sync(() => lock?.release()),
      );
      assert.isDefined(desktop);

      const state = yield* runUntilActiveExits(root, statePath);
      assert.equal(state.update?.status, "failed");
      assert.equal(
        state.update?.status === "failed" ? state.update.reason : undefined,
        "db-owner-busy",
      );
      assert.equal(yield* fs.readFileString(databasePath), "desktop data");
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", state.update!.id)));
    }),
  );

  it.effect("keeps a rollback pending until the owner lock frees up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-pending-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const lockDir = path.dirname(databasePath);
      const backupDir = path.join(root, "runtime", "db-backup", "update-1");
      yield* fs.makeDirectory(lockDir, { recursive: true });
      yield* fs.makeDirectory(backupDir, { recursive: true });
      yield* fs.writeFileString(databasePath, "trial migration");
      yield* fs.writeFileString(path.join(backupDir, "database"), "before trial");
      // The launcher had backed up at this generation and decided to roll back.
      const backup = tryAcquireServerOwnerLock(lockDir, "service-launcher:update-1");
      assert.isDefined(backup);
      backup.release();
      yield* fs.writeFileString(path.join(backupDir, "owner-generation"), `${backup.generation}\n`);
      yield* fs.writeFileString(path.join(backupDir, ".rollback-pending"), "");
      yield* writeUpdateRuntimes(fs, path, root, databasePath, "  process.exit(1);");
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
          update: {
            id: "update-1",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            dbPath: databasePath,
            status: "pending",
          },
        }),
      );

      // A trial process that has not let go yet still holds the lock.
      const lingering = tryAcquireServerOwnerLock(lockDir, "service-trial:update-1");
      assert.isDefined(lingering);
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)));
      const running = launcher.run();
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
      const waiting = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(waiting.update?.status, "pending");
      assert.equal(yield* fs.readFileString(databasePath), "trial migration");
      assert.isTrue(yield* fs.exists(path.join(backupDir, ".rollback-pending")));

      lingering.release();
      const state = yield* runUntilActiveExits(root, statePath);
      assert.equal(state.update?.status, "failed");
      assert.equal(
        state.update?.status === "failed" ? state.update.reason : undefined,
        "rollback-interrupted",
      );
      assert.equal(yield* fs.readFileString(databasePath), "before trial");
      assert.isFalse(yield* fs.exists(backupDir));
    }),
  );
  it.effect("recovers a finished restore without copying over a later server's writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-recopy-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const lockDir = path.dirname(databasePath);
      const backupDir = path.join(root, "runtime", "db-backup", "update-1");
      yield* fs.makeDirectory(lockDir, { recursive: true });
      yield* fs.makeDirectory(backupDir, { recursive: true });
      yield* fs.writeFileString(path.join(backupDir, "database"), "before trial");
      const backup = tryAcquireServerOwnerLock(lockDir, "service-launcher:update-1");
      assert.isDefined(backup);
      backup.release();
      yield* fs.writeFileString(path.join(backupDir, "owner-generation"), `${backup.generation}\n`);
      // The launcher finished the copy and crashed before recording it; a
      // desktop server then took the data and wrote.
      yield* fs.writeFileString(path.join(backupDir, ".rollback-pending"), "");
      tryAcquireServerOwnerLock(lockDir, "service-launcher:update-1")?.release();
      tryAcquireServerOwnerLock(lockDir, "desktop")?.release();
      yield* fs.writeFileString(databasePath, "desktop write after restore");
      yield* writeUpdateRuntimes(fs, path, root, databasePath, "  process.exit(1);");
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
          update: {
            id: "update-1",
            fromVersion: "1.0.0",
            targetVersion: "1.1.0",
            dbPath: databasePath,
            status: "pending",
          },
        }),
      );

      const state = yield* runUntilActiveExits(root, statePath);
      assert.equal(
        state.update?.status === "failed" ? state.update.reason : undefined,
        "rollback-interrupted;db-kept-for-other-server",
      );
      assert.equal(yield* fs.readFileString(databasePath), "desktop write after restore");
    }),
  );
});
