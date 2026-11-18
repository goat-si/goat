// @effect-diagnostics nodeBuiltinImport:off - the test holds the home's ownership lock with node:sqlite.
import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import { vi } from "vite-plus/test";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { restoreDatabaseBackup } from "./serviceLauncherDatabase.ts";

const lockModuleUrl = JSON.stringify(
  NodeURL.pathToFileURL(NodeURL.fileURLToPath(new URL("./serverOwnerLockFile.ts", import.meta.url)))
    .href,
);

const BOUND_MS = 10 * 60_000;

/** Resolves once the launcher has written a line containing the text. */
const observeLauncher = Effect.acquireRelease(
  Effect.sync(() => {
    const waiters: Array<{ readonly text: string; readonly resolve: () => void }> = [];
    const seen: Array<string> = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      const line = String(chunk);
      seen.push(line);
      for (const waiter of waiters) if (line.includes(waiter.text)) waiter.resolve();
      return true;
    });
    const line = (text: string) =>
      seen.some((entry) => entry.includes(text))
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ text, resolve }));
    return { spy, line };
  }),
  ({ spy }) => Effect.sync(() => spy.mockRestore()),
);

/** Another server holding the home: an exclusive transaction on its ownership lock. */
const holdHome = (root: string, lockFile: string) => {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(root, "userdata", lockFile));
  db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
  return () => db[Symbol.dispose]();
};

const scenario = (input: { readonly trialStarted: boolean; readonly lockFile?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-owner-poll-" });
    const statePath = path.join(root, "runtime", "service-state.json");
    const dbPath = path.join(root, "userdata", "statev2.sqlite");
    const markers = path.join(root, "markers");
    yield* fs.makeDirectory(markers, { recursive: true });
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
    yield* fs.writeFileString(dbPath, "database before the update");
    // The active server accepts the update, then finds the home owned and exits before the trial.
    yield* writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime", "goat", "versions", "1.0.0"),
      `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update !== undefined) {
  writeFileSync(${JSON.stringify(path.join(markers, "previous-restarted"))}, context.update.status);
  process.exit(0);
} else {
  process.on("message", (message) => {
    if (message.type !== "update-accepted") return;
    if (${input.trialStarted}) {
      // A trial for this update ran before: its backup and the launcher's marker are on disk.
      const backup = join(${JSON.stringify(root)}, "runtime", "db-backup", message.updateId);
      mkdirSync(backup, { recursive: true });
      writeFileSync(join(backup, "database"), "database before the update");
      const lock = tryAcquireServerOwnerLock(${JSON.stringify(path.dirname(dbPath))}, "service-launcher:" + message.updateId);
      writeFileSync(join(backup, "owner-generation"), String(lock.generation));
      lock.release();
      writeFileSync(join(backup, ".trial-started"), "");
      writeFileSync(${JSON.stringify(dbPath)}, "database the trial migrated");
    }
    process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(dbPath)} });
  setInterval(() => {}, 1_000);
}
`,
    );
    yield* writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime", "goat", "versions", "1.1.0"),
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(path.join(markers, "trial-ran"))}, "ran");
process.exit(1);
`,
    );
    yield* Effect.promise(() =>
      writeServiceState(statePath, { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.0.0" }),
    );
    const clock = { now: 0 };
    const observed = yield* observeLauncher;
    const release = holdHome(root, input.lockFile ?? "server-owner.sqlite");
    yield* Effect.addFinalizer(() => Effect.sync(release));
    const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)), {
      now: () => clock.now,
      stateDirOwnerPollMs: 5,
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
    const running = launcher.run().catch((error: unknown) => error);
    yield* Effect.promise(() => observed.line("Another GOAT server owns this GOAT home"));
    return { fs, root, statePath, dbPath, markers, clock, observed, release, running };
  });

it.layer(NodeServices.layer)("a pending update while another server owns the home", (it) => {
  it.effect("stays pending while the home is owned and starts its trial once it frees", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ trialStarted: false });
      assert.equal(
        (yield* Effect.promise(() => readServiceState(s.statePath))).update?.status,
        "pending",
      );
      s.release();
      assert.include(
        String(yield* Effect.promise(() => s.running)),
        "Active child exited unexpectedly (0)",
      );
      assert.equal(yield* s.fs.readFileString(NodePath.join(s.markers, "trial-ran")), "ran");
      yield* Effect.promise(() => s.observed.line("The GOAT home is free again"));
    }),
  );

  it.effect("fails with db-owner-busy at the bound and discards a backup no trial opened", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ trialStarted: false });
      assert.equal(
        (yield* Effect.promise(() => readServiceState(s.statePath))).update?.status,
        "pending",
      );
      s.clock.now = BOUND_MS;
      yield* Effect.promise(() => s.observed.line("the update failed (db-owner-busy)"));
      const state = yield* Effect.promise(() => readServiceState(s.statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.deepEqual(
        state.update?.status === "failed" ? [state.update.status, state.update.reason] : [],
        ["failed", "db-owner-busy"],
      );
      assert.isFalse(
        yield* s.fs.exists(NodePath.join(s.root, "runtime", "db-backup", state.update?.id ?? "")),
      );
      assert.isFalse(yield* s.fs.exists(NodePath.join(s.markers, "trial-ran")));
    }),
  );

  it.effect("at the bound waits for a legacy owner and preserves its writes and the backup", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ trialStarted: true });
      const pending = (yield* Effect.promise(() => readServiceState(s.statePath))).update;
      assert.equal(pending?.status, "pending");
      const backup = NodePath.join(s.root, "runtime", "db-backup", pending?.id ?? "");
      yield* s.fs.writeFileString(s.dbPath, "database the legacy server wrote");
      s.clock.now = BOUND_MS;
      const decision = yield* Effect.promise(() =>
        Promise.race([
          s.observed
            .line("Rollback is waiting for the GOAT home to become free.")
            .then(() => "waiting"),
          s.running.then(() => "restarted while owned"),
        ]),
      );
      assert.equal(decision, "waiting");
      assert.equal(
        (yield* Effect.promise(() => readServiceState(s.statePath))).update?.status,
        "pending",
      );
      assert.equal(yield* s.fs.readFileString(s.dbPath), "database the legacy server wrote");
      s.release();
      assert.include(
        String(yield* Effect.promise(() => s.running)),
        "Active child exited unexpectedly (0)",
      );
      assert.equal(
        yield* s.fs.readFileString(NodePath.join(s.markers, "previous-restarted")),
        "failed",
      );
      const state = yield* Effect.promise(() => readServiceState(s.statePath));
      assert.deepEqual(
        state.update?.status === "failed" ? [state.update.status, state.update.reason] : [],
        ["failed", "db-owner-busy;db-kept-for-other-server"],
      );
      assert.equal(yield* s.fs.readFileString(s.dbPath), "database the legacy server wrote");
      assert.equal(
        yield* s.fs.readFileString(NodePath.join(backup, "database")),
        "database before the update",
      );
    }),
  );

  it.effect("treats a generation lock without the legacy lock as an owned home at the bound", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ trialStarted: false, lockFile: "server-owner.lock" });
      s.clock.now = BOUND_MS;
      const decision = yield* Effect.promise(() =>
        Promise.race([
          s.observed.line("the update failed (db-owner-busy)").then(() => "failed at the bound"),
          s.running.then(() => "restarted while owned"),
        ]),
      );
      assert.equal(decision, "failed at the bound");
      assert.isFalse(yield* s.fs.exists(NodePath.join(s.markers, "previous-restarted")));
      assert.isFalse(yield* s.fs.exists(NodePath.join(s.markers, "trial-ran")));
      s.release();
      assert.include(
        String(yield* Effect.promise(() => s.running)),
        "Active child exited unexpectedly (0)",
      );
      assert.equal(
        yield* s.fs.readFileString(NodePath.join(s.markers, "previous-restarted")),
        "failed",
      );
    }),
  );

  it.effect("keeps the snapshot and committed writes after an unattributed trial refusal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-trial-refusal-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const stateDir = path.join(root, "userdata");
      const dbPath = path.join(stateDir, "statev2.sqlite");
      const backupDir = path.join(root, "runtime", "db-backup", "trial");
      yield* fs.makeDirectory(stateDir);
      {
        using db = new NodeSqlite.DatabaseSync(dbPath);
        db.exec("CREATE TABLE messages (body TEXT)");
      }
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "goat", "versions", "1.0.0"),
        "process.exit(0);",
      );
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "goat", "versions", "1.1.0"),
        `
import { DatabaseSync } from "node:sqlite";
const legacyLock = new DatabaseSync(${JSON.stringify(path.join(stateDir, "server-owner.sqlite"))});
legacyLock.exec("BEGIN EXCLUSIVE");
const db = new DatabaseSync(${JSON.stringify(dbPath)});
db.exec("INSERT INTO messages VALUES ('committed by the legacy owner')");
db.close();
legacyLock.close();
process.exit(${SERVER_EXIT_CODE_STATE_DIR_OWNED});
`,
      );
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "trial",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending" as const,
        },
      };
      yield* Effect.promise(() => writeServiceState(statePath, state));
      const launcher = new Launcher(root, state, { stateDirOwnerPollMs: 5 });
      yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
      assert.include(
        String(yield* Effect.promise(() => launcher.run().catch((error: unknown) => error))),
        "Active child exited unexpectedly (0)",
      );
      using live = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      assert.equal(
        live.prepare("SELECT body FROM messages").get()?.body,
        "committed by the legacy owner",
      );
      using backup = new NodeSqlite.DatabaseSync(path.join(backupDir, "database"), {
        readOnly: true,
      });
      assert.isUndefined(backup.prepare("SELECT body FROM messages").get());
      const outcome = (yield* Effect.promise(() => readServiceState(statePath))).update;
      assert.equal(
        outcome?.status === "failed" ? outcome.reason : undefined,
        "state-dir-owned;db-kept-for-other-server",
      );
    }),
  );

  it.effect("requires explicit recovery after a legacy owner interrupted rollback recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-restore-conflict-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const dbPath = path.join(root, "userdata", "statev2.sqlite");
      const backupDir = path.join(root, "runtime", "db-backup", "trial");
      const snapshot = path.join(backupDir, "database");
      const restoreMarker = path.join(backupDir, ".restore-pending");
      const childStarted = path.join(root, "child-started");
      yield* fs.makeDirectory(path.dirname(dbPath));
      yield* fs.makeDirectory(backupDir, { recursive: true });
      {
        using db = new NodeSqlite.DatabaseSync(snapshot);
        db.exec("CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('before trial');");
      }
      yield* fs.writeFileString(dbPath, "truncated");
      yield* fs.writeFileString(restoreMarker, "");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "goat", "versions", "1.0.0"),
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(childStarted)}, "");
process.exit(0);`,
      );
      const state = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "trial",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending" as const,
        },
      };
      yield* Effect.promise(() => writeServiceState(statePath, state));
      const busy = yield* Effect.acquireUseRelease(
        Effect.sync(() => holdHome(root, "server-owner.sqlite")),
        () => Effect.promise(() => restoreDatabaseBackup(root, state.update)),
        (release) => Effect.sync(release),
      );
      assert.equal(busy, "busy");
      const run = () =>
        Effect.promise(async () => {
          const launcher = new Launcher(root, await readServiceState(statePath));
          return launcher.run().catch((error: unknown) => error);
        });
      assert.include(String(yield* run()), "Database recovery required");
      assert.isFalse(yield* fs.exists(childStarted));
      assert.equal(yield* fs.readFileString(dbPath), "truncated");
      assert.isTrue(yield* fs.exists(restoreMarker));
      assert.isTrue(yield* fs.exists(path.join(backupDir, ".untracked-owner")));
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);

      yield* fs.copyFile(snapshot, dbPath);
      yield* fs.remove(restoreMarker);
      assert.include(String(yield* run()), "Active child exited unexpectedly (0)");
      assert.isTrue(yield* fs.exists(childStarted));
      assert.isTrue(yield* fs.exists(snapshot));
      using live = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
      assert.equal(live.prepare("SELECT body FROM messages").get()?.body, "before trial");
    }),
  );

  it.effect.each([
    ["a tracked desktop write", true, "foreign", true, "intact", true],
    ["a truncated live database and foreign history", true, "foreign", true, "truncated", true],
    ["a truncated live database and only update owners", true, "ours", true, "truncated", false],
    ["an intact live database and only update owners", true, "ours", true, "intact", false],
    ["a lost generation log", true, "lost", true, "truncated", true],
    ["a missing snapshot during a resumed restore", true, "ours", false, "truncated", true],
    ["a missing snapshot before restore starts", false, "ours", false, "intact", true],
    [
      "a missing backup directory during probation rollback",
      false,
      "probation",
      false,
      "truncated",
      true,
    ],
    ["no backup directory before a trial", false, "pretrial", false, "intact", false],
  ] as const)(
    "recovers safely with %s",
    ([_scenario, restoreStarted, history, hasSnapshot, liveState, blocked]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-resume-" });
        const stateDir = path.join(root, "userdata");
        const dbPath = path.join(stateDir, "statev2.sqlite");
        const statePath = path.join(root, "runtime", "service-state.json");
        const backupDir = path.join(root, "runtime", "db-backup", "trial");
        const snapshot = path.join(backupDir, "database");
        const restoreMarker = path.join(backupDir, ".restore-pending");
        const conflictMarker = path.join(backupDir, ".untracked-owner");
        const childStarted = path.join(root, "child-started");
        yield* fs.makeDirectory(stateDir);
        const hasBackupDirectory = history !== "probation" && history !== "pretrial";
        if (hasBackupDirectory) yield* fs.makeDirectory(backupDir, { recursive: true });
        if (hasSnapshot) {
          using db = new NodeSqlite.DatabaseSync(snapshot);
          db.exec(
            "CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('before trial');",
          );
        }
        if (liveState === "intact") {
          using db = new NodeSqlite.DatabaseSync(dbPath);
          db.exec(
            "CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('before trial');",
          );
        } else {
          yield* fs.writeFileString(dbPath, "truncated");
        }
        if (history === "lost") {
          yield* fs.writeFileString(path.join(backupDir, "owner-generation"), "9");
        } else if (hasBackupDirectory) {
          const backup = tryAcquireServerOwnerLock(stateDir, "service-launcher:trial");
          assert.isDefined(backup);
          backup.release();
          yield* fs.writeFileString(
            path.join(backupDir, "owner-generation"),
            String(backup.generation),
          );
        }
        if (restoreStarted) yield* fs.writeFileString(restoreMarker, "");
        if (hasBackupDirectory)
          yield* fs.writeFileString(path.join(backupDir, ".rollback-pending"), "");
        if (history === "foreign") {
          const owner = tryAcquireServerOwnerLock(stateDir, "desktop");
          assert.isDefined(owner);
          const releaseLegacy = holdHome(root, "server-owner.sqlite");
          try {
            if (liveState === "intact") {
              using db = new NodeSqlite.DatabaseSync(dbPath);
              db.exec("INSERT INTO messages VALUES ('committed by desktop')");
            }
          } finally {
            releaseLegacy();
            owner.release();
          }
        }
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", "1.0.0"),
          `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(childStarted)}, "");
process.exit(0);`,
        );
        const update = { id: "trial", fromVersion: "1.0.0", targetVersion: "1.1.0" };
        const state =
          history === "probation"
            ? {
                protocol: SERVICE_LAUNCHER_PROTOCOL,
                activeVersion: "1.1.0",
                update: { ...update, status: "committed" as const },
                probation: { dbPath, deadline: 1, rollbackReason: "probation-exit:42" },
              }
            : {
                protocol: SERVICE_LAUNCHER_PROTOCOL,
                activeVersion: "1.0.0",
                update: { ...update, dbPath, status: "pending" as const },
              };
        yield* Effect.promise(() => writeServiceState(statePath, state));
        const run = () =>
          Effect.promise(async () => {
            const launcher = new Launcher(root, await readServiceState(statePath));
            return launcher.run().catch((error: unknown) => error);
          });
        const liveBefore = yield* fs.readFile(dbPath);
        const backupBefore = hasSnapshot ? yield* fs.readFile(snapshot) : undefined;
        const outcome = String(yield* run());
        if (blocked) {
          assert.include(outcome, "Database recovery required");
          assert.isFalse(yield* fs.exists(childStarted));
          assert.isTrue(yield* fs.exists(restoreMarker));
          assert.isTrue(yield* fs.exists(conflictMarker));
          assert.deepEqual(yield* fs.readFile(dbPath), liveBefore);
          if (backupBefore !== undefined)
            assert.deepEqual(yield* fs.readFile(snapshot), backupBefore);
          assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), state);

          if (history === "foreign" && liveState === "intact") {
            assert.include(String(yield* run()), "Database recovery required");
            yield* fs.remove(restoreMarker);
            assert.include(String(yield* run()), "Active child exited unexpectedly (0)");
            using live = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
            assert.equal(
              live.prepare("SELECT body FROM messages WHERE body = 'committed by desktop'").get()
                ?.body,
              "committed by desktop",
            );
            assert.isTrue(yield* fs.exists(snapshot));
          }
        } else {
          assert.include(outcome, "Active child exited unexpectedly (0)");
          assert.isTrue(yield* fs.exists(childStarted));
          assert.isFalse(yield* fs.exists(backupDir));
          assert.deepEqual(yield* fs.readFile(dbPath), backupBefore ?? liveBefore);
        }
      }),
  );
});
