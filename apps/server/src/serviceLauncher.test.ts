// @effect-diagnostics nodeBuiltinImport:off - observes the children the launcher spawns with Node built-ins.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SERVER_EXIT_CODE_DATABASE_AHEAD, SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { vi } from "vite-plus/test";
import {
  compareExactServiceVersions,
  decodeServiceLauncherChildMessage,
  decodeServiceState,
  isExactServiceVersion,
  SERVICE_ENV_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STOP_MARKER_FILE,
} from "./cloud/serviceProtocol.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";
import {
  databaseBackupBlocker,
  Launcher,
  main,
  PROBATION_MS,
  readServiceEnvironment,
  readServiceState,
  SMOKE_TIMEOUT_MS,
  smokeProbeHostname,
  writeServiceState,
  type BackupSpaceProbe,
} from "./serviceLauncher.ts";

const childObserver = vi.hoisted(() => ({
  current: undefined as ((child: NodeChildProcess.ChildProcess) => void) | undefined,
}));

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawnedChildren.push(child);
    childObserver.current?.(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const writeSparseFile = (filePath: string, size: number) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(filePath, "");
    yield* fileSystem.truncate(filePath, size);
  });

it("probes a wildcard listener on loopback of its family and a specific address directly", () => {
  assert.equal(smokeProbeHostname(undefined), "127.0.0.1");
  assert.equal(smokeProbeHostname("0.0.0.0"), "127.0.0.1");
  assert.equal(smokeProbeHostname("::"), "::1");
  assert.equal(smokeProbeHostname("::1"), "::1");
  assert.equal(smokeProbeHostname("100.64.0.7"), "100.64.0.7");
});

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

const refusalCases = [
  {
    code: SERVER_EXIT_CODE_STATE_DIR_OWNED,
    reason: "state-dir-owned",
    message: "Another GOAT server owns this GOAT home. Stop it, then restart this service.",
  },
  {
    code: SERVER_EXIT_CODE_DATABASE_AHEAD,
    reason: "database-ahead",
    message:
      "This GOAT build is older than the data in this GOAT home. Update GOAT or install a newer service, then restart this service.",
  },
];

const observeRefusal = (message: string) =>
  Effect.gen(function* () {
    const refused = Promise.withResolvers<"idle">();
    const lines: Array<string> = [];
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
          lines.push(String(chunk));
          if (String(chunk).includes(message)) refused.resolve("idle");
          return true;
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    return { refused: refused.promise, lines };
  });

it.layer(NodeServices.layer)("service state persistence", (it) => {
  it.effect(
    "loads optional service.env literally without changing inherited or managed variables",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-env-" });
        const inherited = Object.freeze({
          PATH: "inherited-path",
          GOAT_HOME: root,
          GOAT_BOOT_SERVICE_UNIT: "managed-unit",
          GOAT_SERVICE_LAUNCHER_CONTEXT: "managed-context",
          GOAT_PORT: "ambient",
        });
        assert.deepEqual(
          yield* Effect.promise(() => readServiceEnvironment(root, inherited)),
          inherited,
        );
        yield* fs.writeFileString(
          path.join(root, SERVICE_ENV_FILE),
          [
            "# service configuration",
            "export GOAT_PORT=1234 # inline comment",
            'GOAT_TOKEN="literal $HOME ${USER} $(whoami) # token"',
            'MULTILINE="first\nsecond"',
            "EMPTY=",
            "PATH=/bad",
            "Path=/bad",
            "GOAT_HOME=/bad",
            "goat_home=/bad",
            "GOAT_BOOT_SERVICE_UNIT=bad",
            "goat_boot_service_unit=bad",
            "GOAT_SERVICE_LAUNCHER_CONTEXT=bad",
            "goat_service_launcher_context=bad",
          ].join("\n"),
        );
        assert.deepEqual(yield* Effect.promise(() => readServiceEnvironment(root, inherited)), {
          ...inherited,
          GOAT_PORT: "1234",
          GOAT_TOKEN: "literal $HOME ${USER} $(whoami) # token",
          MULTILINE: "first\nsecond",
          EMPTY: "",
        });
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

      yield* fs.writeFileString(restartPending, "1.0.1\n");
      yield* run();
      assert.isTrue(yield* fs.exists(restartPending));

      yield* fs.writeFileString(restartPending, "1.0.0\n");
      yield* run();
      assert.isFalse(yield* fs.exists(restartPending));
    }),
  );

  it.effect.each(refusalCases)(
    "stays idle when the active server refuses with $code",
    ({ code, message }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-refused-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", "1.0.0"),
          `process.exit(${code});\n`,
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        const { refused, lines } = yield* observeRefusal(message);
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
        const spawnCount = spawnedChildren.length;
        let completed = false;
        const running = launcher
          .run()
          .catch((error: unknown) => error)
          .finally(() => {
            completed = true;
          });
        assert.equal(yield* Effect.promise(() => Promise.race([refused, running])), "idle");
        assert.isFalse(completed);
        assert.equal(spawnedChildren.length - spawnCount, 1);
        assert.deepEqual(lines, [`[service-launcher] ${message}\n`]);
        yield* Effect.promise(() => launcher.stop("SIGTERM"));
        yield* Effect.promise(() => running);
      }),
  );

  it.effect.each(refusalCases)(
    "fails a pending update without restoring data when the active server refuses with $code",
    ({ code, reason, message }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-refused-update-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const dbPath = path.join(root, "userdata", "statev2.sqlite");
        yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
        yield* fs.writeFileString(dbPath, "newer database");
        yield* fs.writeFileString(dbPath + "-wal", "newer wal");
        yield* fs.writeFileString(dbPath + "-shm", "newer shm");
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", "1.0.0"),
          `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update !== undefined) process.exit(0);
process.on("message", message => {
  if (message.type !== "update-accepted") return;
  const backup = join(${JSON.stringify(root)}, "runtime", "db-backup", message.updateId);
  mkdirSync(backup, { recursive: true });
  writeFileSync(join(backup, "database"), "older snapshot");
  const lock = tryAcquireServerOwnerLock(${JSON.stringify(path.dirname(dbPath))}, "service-launcher:" + message.updateId);
  writeFileSync(join(backup, "owner-generation"), String(lock.generation));
  lock.release();
  process.exit(${code});
});
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(dbPath)} });
`,
        );
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", "1.1.0"),
          "process.exit(17);",
        );
        yield* Effect.promise(() =>
          writeServiceState(statePath, {
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: "1.0.0",
          }),
        );
        // Hold the handoff timer so the accepted update's active exit drives the transition.
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const { refused, lines } = yield* observeRefusal(message);
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
        const spawnCount = spawnedChildren.length;
        const running = launcher.run().catch((error: unknown) => error);
        assert.equal(yield* Effect.promise(() => Promise.race([refused, running])), "idle");
        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "failed");
        assert.equal(state.update?.status === "failed" ? state.update.reason : undefined, reason);
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", state.update!.id)));
        assert.equal(yield* fs.readFileString(dbPath), "newer database");
        assert.equal(yield* fs.readFileString(dbPath + "-wal"), "newer wal");
        assert.equal(yield* fs.readFileString(dbPath + "-shm"), "newer shm");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
        assert.equal(spawnedChildren.length - spawnCount, 1);
        assert.deepEqual(lines, [`[service-launcher] ${message}\n`]);
        yield* Effect.promise(() => launcher.stop("SIGTERM"));
        assert.isUndefined(yield* Effect.promise(() => running));
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

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { probationMs: 0 },
      );
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

  it.effect("rolls back invalid trials with the startup environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-rollback-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const observationsPath = path.join(root, "environment-observations.jsonl");
      const envPath = path.join(root, SERVICE_ENV_FILE);
      yield* fs.writeFileString(envPath, "GOAT_TEST_SERVICE_TOKEN=initial\n");
      vi.stubEnv("GOAT_HOME", root);
      vi.stubEnv("GOAT_TEST_SERVICE_TOKEN", "inherited");
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "before trial");
      const encodedDatabasePath = JSON.stringify(databasePath);
      const childSource = `
import { appendFileSync, writeFileSync } from "node:fs";
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
appendFileSync(${JSON.stringify(observationsPath)}, JSON.stringify({
  token: process.env.GOAT_TEST_SERVICE_TOKEN,
  update: context.update?.status ?? "active",
}) + "\\n");
if (context.update?.status === "pending") {
  process.send({ type: "prepared", updateId: "wrong-update" });
} else if (context.update === undefined) {
  writeFileSync(${JSON.stringify(envPath)}, "GOAT_TEST_SERVICE_TOKEN=changed\\n");
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

      yield* Effect.promise(() =>
        main().then(
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
      const observations = (yield* fs.readFileString(observationsPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(observations, [
        { token: "initial", update: "active" },
        { token: "initial", update: "pending" },
        { token: "initial", update: "rolled-back" },
      ]);
      assert.equal(process.env.GOAT_TEST_SERVICE_TOKEN, "inherited");
      assert.equal(yield* fs.readFileString(envPath), "GOAT_TEST_SERVICE_TOKEN=changed\n");
    }),
  );

  it.effect.each(["file", "symlink", "dangling symlink"] as const)(
    "restores the database when a migrating trial exits, with the database a %s",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-db-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        const databasePath = path.join(root, "userdata", "state.sqlite");
        const databaseFile =
          kind === "file" ? databasePath : path.join(root, "data", "original.sqlite");
        const linkTarget = kind === "dangling symlink" ? "../original.sqlite" : databaseFile;
        const original = "database before migration";
        yield* fs.makeDirectory(path.dirname(databaseFile), { recursive: true });
        if (kind === "dangling symlink") {
          yield* fs.makeDirectory(path.join(root, "data", "sub"));
          yield* fs.symlink(path.join(root, "data", "sub"), path.dirname(databasePath));
        } else {
          yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
        }
        yield* fs.writeFileString(databaseFile, original);
        if (kind !== "file") yield* fs.symlink(linkTarget, databasePath);
        const encodedDatabasePath = JSON.stringify(databasePath);
        const childSource = `
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  tryAcquireServerOwnerLock(dirname(context.update.dbPath), "service-trial:" + context.update.id);
  writeFileSync(context.update.dbPath, "database after migration");
  writeFileSync(context.update.dbPath + "-wal", "trial wal");
  writeFileSync(context.update.dbPath + "-shm", "trial shm");
  ${kind === "dangling symlink" ? "unlinkSync(realpathSync(context.update.dbPath));" : ""}
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

        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
        );
        yield* Effect.promise(() =>
          launcher.run().then(
            () => Promise.reject(new Error("launcher unexpectedly completed")),
            () => Promise.resolve(),
          ),
        );

        const state = yield* Effect.promise(() => readServiceState(statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(yield* fs.readFileString(databaseFile), original);
        if (kind !== "file") assert.equal(yield* fs.readLink(databasePath), linkTarget);
        assert.isFalse(yield* fs.exists(path.join(root, "original.sqlite")));
        assert.isFalse(yield* fs.exists(`${databasePath}-wal`));
        assert.isFalse(yield* fs.exists(`${databasePath}-shm`));
        const updateId = state.update?.id;
        assert.isDefined(updateId);
        assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", updateId)));
      }),
  );

  const requestRejectedUpdate = (backupSpaceProbe: Partial<BackupSpaceProbe>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-space-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      const replyPath = path.join(root, "rejection.txt");
      const trialMarker = path.join(root, "trial-started");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath, replyPath, trialMarker });
      const childSource = `
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const paths = ${encoded};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
if (context.update?.status === "pending") {
  writeFileSync(paths.trialMarker, "started");
  process.exit(1);
} else if (context.update === undefined) {
  process.on("message", (message) => {
    if (message.type === "update-rejected") {
      writeFileSync(paths.replyPath, message.reason);
      process.exit(0);
    }
  });
  process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath });
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

      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        { backupSpaceProbe },
      );
      yield* Effect.promise(() =>
        launcher.run().then(
          () => Promise.reject(new Error("launcher unexpectedly completed")),
          () => Promise.resolve(),
        ),
      );

      return {
        reason: yield* fs.readFileString(replyPath),
        trialStarted: yield* fs.exists(trialMarker),
        state: yield* Effect.promise(() => readServiceState(statePath)),
      };
    });

  it.effect("refuses a backup that cannot fit and leaves the server running", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.resolve(0),
        canClone: () => Promise.resolve(true),
      });

      assert.include(reason, "Not enough free disk space");
      assert.include(reason, "The server was not stopped");
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("refuses the update when free space cannot be checked", () =>
    Effect.gen(function* () {
      const { reason, trialStarted, state } = yield* requestRejectedUpdate({
        readFreeBytes: () => Promise.reject(new Error("statfs unavailable")),
      });

      assert.include(
        reason,
        "Could not check that the database backup fits before updating: statfs unavailable",
      );
      assert.isFalse(trialStarted);
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("records no update when the server exits during the backup check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-exit-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const databasePath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(databasePath), { recursive: true });
      yield* fs.writeFileString(databasePath, "database");
      const encoded = JSON.stringify({ databasePath });
      const childSource = `
const paths = ${encoded};
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: paths.databasePath }, () =>
  process.exit(3),
);
setInterval(() => {}, 1_000);
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
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        {
          backupSpaceProbe: {
            readFreeBytes: () => {
              const child = spawnedChildren.at(-1)!;
              return new Promise((resolve) => {
                if (!child.connected) resolve(Number.MAX_SAFE_INTEGER);
                else child.once("disconnect", () => resolve(Number.MAX_SAFE_INTEGER));
              });
            },
          },
        },
      );
      const failure = yield* Effect.promise(() =>
        launcher.run().then(
          () => new Error("launcher unexpectedly completed"),
          (cause: unknown) => cause as Error,
        ),
      );

      assert.include(failure.message, "Active child exited unexpectedly (3)");
      const state = yield* Effect.promise(() => readServiceState(statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.isUndefined(state.update);
    }),
  );

  it.effect("checks database backup space against clone or full-copy needs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-launcher-blocker-" });
      const databasePath = path.join(root, "state.sqlite");
      yield* writeSparseFile(databasePath, 10 * 1024 ** 3);
      const check = (free: number, cloneable: boolean) =>
        Effect.promise(() =>
          databaseBackupBlocker(root, databasePath, {
            readFreeBytes: () => Promise.resolve(free),
            canClone: () => Promise.resolve(cloneable),
          }),
        );

      assert.isUndefined(yield* check(11 * 1024 ** 3, false));
      assert.isUndefined(yield* check(1.5 * 1024 ** 3, true));
      assert.include((yield* check(0.5 * 1024 ** 3, true)) ?? "", "1.0 GB needed, 0.5 GB free");
      const blocker = yield* check(8 * 1024 ** 3, false);
      assert.include(blocker ?? "", "Not enough free disk space");
      assert.include(blocker ?? "", "10.5 GB needed, 8.0 GB free");
      assert.include(blocker ?? "", "The server was not stopped");
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

it("decodes legacy prepared messages and the optional bound port without a protocol bump", () => {
  assert.equal(SERVICE_LAUNCHER_PROTOCOL, 3);
  assert.deepEqual(decodeServiceLauncherChildMessage({ type: "prepared", updateId: "u" }), {
    type: "prepared",
    updateId: "u",
  });
  assert.deepEqual(
    decodeServiceLauncherChildMessage({
      type: "prepared",
      updateId: "u",
      port: 1234,
      future: true,
    }),
    {
      type: "prepared",
      updateId: "u",
      port: 1234,
    },
  );
  for (const port of [0, -1, 65536, 1.5, "1234", null]) {
    assert.isUndefined(
      decodeServiceLauncherChildMessage({ type: "prepared", updateId: "u", port }),
    );
  }
});

const validSmokeDescriptor = {
  serverVersion: "1.1.0",
  protocol: { ssh: { min: 1001, max: 1001 }, orchestration: { min: 1, max: 2 } },
};

// IPC milestones mark completed launcher writes; timers never stand in for filesystem work.
const healthFixture = (
  input: {
    readonly descriptor?: unknown;
    readonly status?: number;
    readonly failStart?: number;
    readonly hang?: boolean;
    readonly legacy?: boolean;
    readonly listenHost?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-launcher-health-" });
    const statePath = path.join(root, "runtime", "service-state.json");
    const dbPath = path.join(root, "userdata", "statev2.sqlite");
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
    yield* fs.writeFileString(dbPath, "original database");
    yield* fs.writeFileString(dbPath + "-wal", "original wal");
    const pending = {
      id: "health-update",
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      dbPath,
      status: "pending" as const,
    };
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
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tryAcquireServerOwnerLock } from ${lockModuleUrl};
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
const dbPath = ${JSON.stringify(dbPath)};
const lock = tryAcquireServerOwnerLock(dirname(dbPath), context.update.status === "pending" ? "service-trial:" + context.update.id : context.probation === true ? "service-probation:" + context.update.id : "service-active:restart");
process.on("message", message => {
  if (message.type === "test-exit") process.exit(message.code ?? 42);
  if (message.type === "test-signal") process.kill(process.pid, "SIGTERM");
  if (message.type === "test-release") { lock.release(); process.send({ type: "test-released" }); }
  if (message.type === "committed") {
    writeFileSync(dbPath, "committed writes");
    writeFileSync(dbPath + "-wal", "committed wal");
    writeFileSync(dbPath + "-shm", "committed shm");
    process.send({ type: "test-committed" });
  }
});
if (context.update.status === "committed") {
  process.send({ type: "test-restarted" });
} else if (${input.failStart !== undefined}) {
  writeFileSync(dbPath, "failed migration");
  process.exit(${input.failStart ?? 17});
} else {
  const server = createServer((request, response) => {
    if (request.url !== "/.well-known/goat/environment") process.exit(19);
    response.writeHead(${input.status ?? 200}, { "content-type": "application/json" });
    response.write(${JSON.stringify(JSON.stringify(input.descriptor ?? validSmokeDescriptor))});
    ${input.hang ? 'process.send({ type: "test-probing" });' : "response.end();"}
  });
  server.listen(0, ${JSON.stringify(input.listenHost ?? "127.0.0.1")}, () => process.send({ type: "prepared", updateId: context.update.id, ${input.legacy ? "" : "port: server.address().port, host: server.address().address"} }));
}
`,
    );
    yield* Effect.promise(() =>
      writeServiceState(statePath, {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: pending,
      }),
    );
    const milestones = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<NodeChildProcess.ChildProcess>>
    >();
    const milestone = (type: string) => {
      let deferred = milestones.get(type);
      if (deferred === undefined) {
        deferred = Promise.withResolvers<NodeChildProcess.ChildProcess>();
        milestones.set(type, deferred);
      }
      return deferred;
    };
    childObserver.current = (child) =>
      child.on("message", (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          typeof value.type === "string"
        )
          milestone(value.type).resolve(child);
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        childObserver.current = undefined;
      }),
    );
    const start = (options: ConstructorParameters<typeof Launcher>[2] = {}) =>
      Effect.gen(function* () {
        const launcher = new Launcher(
          root,
          yield* Effect.promise(() => readServiceState(statePath)),
          options,
        );
        const running = launcher.run().then(
          () => undefined,
          (error: unknown) => error,
        );
        yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
        return { launcher, running };
      });
    return {
      fs,
      path,
      root,
      statePath,
      dbPath,
      pending,
      start,
      wait: (type: string) => Effect.promise(() => milestone(type).promise),
    };
  });

it.layer(NodeServices.layer)("post-update health", (it) => {
  // An IPv6-only listener is unreachable on 127.0.0.1, so a probe of the wrong family rolls back.
  it.effect.each(["::1", "127.0.0.1"])("smoke-probes the address the trial bound (%s)", (host) =>
    Effect.gen(function* () {
      const f = yield* healthFixture({ listenHost: host });
      yield* f.start({ now: () => 1000 });
      yield* f.wait("test-committed");
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(state.update?.status, "committed");
      assert.equal(state.activeVersion, "1.1.0");
    }),
  );

  it.effect.each([
    { name: "failed start", input: { failStart: 17 }, reason: "candidate-exited:17" },
    {
      name: "database-ahead trial",
      input: { failStart: SERVER_EXIT_CODE_DATABASE_AHEAD },
      reason: "candidate-exited:79",
    },
    {
      name: "wrong version",
      input: { descriptor: { ...validSmokeDescriptor, serverVersion: "9.0.0" } },
      reason: "smoke-failed:version",
    },
    { name: "HTTP failure", input: { status: 503 }, reason: "smoke-failed:http-503" },
    {
      name: "missing ranges",
      input: { descriptor: { serverVersion: "1.1.0" } },
      reason: "smoke-failed:protocol",
    },
    {
      name: "invalid ranges",
      input: {
        descriptor: {
          ...validSmokeDescriptor,
          protocol: { ...validSmokeDescriptor.protocol, ssh: { min: 2, max: 1 } },
        },
      },
      reason: "smoke-failed:protocol",
    },
  ])("rolls back $name before committing", ({ input, reason }) =>
    Effect.gen(function* () {
      const f = yield* healthFixture(input);
      const { running } = yield* f.start();
      assert.instanceOf(yield* Effect.promise(() => running), Error);
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.deepEqual(state.update, {
        id: f.pending.id,
        fromVersion: "1.0.0",
        targetVersion: "1.1.0",
        status: "rolled-back",
        reason,
      });
      assert.equal(yield* f.fs.readFileString(f.dbPath), "original database");
    }),
  );

  it.effect("bounds the whole smoke response by 30 seconds", () =>
    Effect.gen(function* () {
      const f = yield* healthFixture({ hang: true });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const { running } = yield* f.start();
      yield* f.wait("test-probing");
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(SMOKE_TIMEOUT_MS));
      yield* Effect.promise(() => running);
      assert.equal(
        (yield* Effect.promise(() => readServiceState(f.statePath))).update?.status,
        "rolled-back",
      );
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "smoke-failed:timeout",
      );
    }),
  );

  it.effect.each(refusalCases)(
    "does not roll back a committed probation when the server refuses with $code",
    ({ code, message }) =>
      Effect.gen(function* () {
        const f = yield* healthFixture();
        const { refused, lines } = yield* observeRefusal(message);
        const spawnCount = spawnedChildren.length;
        const { launcher, running } = yield* f.start({ now: () => 1000 });
        const child = yield* f.wait("test-committed");
        const committed = yield* Effect.promise(() => readServiceState(f.statePath));
        child.send({ type: "test-exit", code });
        assert.equal(yield* Effect.promise(() => Promise.race([refused, running])), "idle");
        assert.deepEqual(yield* Effect.promise(() => readServiceState(f.statePath)), committed);
        assert.equal(yield* f.fs.readFileString(f.dbPath), "committed writes");
        assert.equal(yield* f.fs.readFileString(f.dbPath + "-wal"), "committed wal");
        assert.equal(yield* f.fs.readFileString(f.dbPath + "-shm"), "committed shm");
        assert.equal(
          yield* f.fs.readFileString(
            f.path.join(f.root, "runtime", "db-backup", f.pending.id, "database"),
          ),
          "original database",
        );
        assert.equal(spawnedChildren.length - spawnCount, 1);
        assert.deepEqual(lines, [`[service-launcher] ${message}\n`]);
        yield* Effect.promise(() => launcher.stop("SIGTERM"));
        assert.isUndefined(yield* Effect.promise(() => running));
      }),
  );

  it.effect.each([false, true])(
    "keeps the snapshot after commit and rolls back a probation exit (legacy: %s)",
    (legacy) =>
      Effect.gen(function* () {
        const f = yield* healthFixture({ legacy });
        const { running } = yield* f.start({ now: () => 1000 });
        const child = yield* f.wait("test-committed");
        const committed = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(committed.update?.status, "committed");
        assert.equal(committed.probation?.deadline, 1000 + PROBATION_MS);
        assert.equal(
          yield* f.fs.readFileString(
            f.path.join(f.root, "runtime", "db-backup", f.pending.id, "database"),
          ),
          "original database",
        );
        child.send({ type: "test-exit" });
        yield* Effect.promise(() => running);
        const rolledBack = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(rolledBack.activeVersion, "1.0.0");
        assert.equal(
          rolledBack.update?.status === "rolled-back" ? rolledBack.update.reason : undefined,
          "probation-exit:42",
        );
        assert.isUndefined(rolledBack.probation);
        assert.equal(yield* f.fs.readFileString(f.dbPath), "original database");
        assert.equal(yield* f.fs.readFileString(f.dbPath + "-wal"), "original wal");
        assert.isFalse(yield* f.fs.exists(f.dbPath + "-shm"));
      }),
  );

  it.effect(
    "discards the snapshot at the deadline and leaves later exits to the service manager",
    () =>
      Effect.gen(function* () {
        const f = yield* healthFixture();
        let now = 1000;
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
        const { running } = yield* f.start({ now: () => now });
        const child = yield* f.wait("test-committed");
        now += PROBATION_MS;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(PROBATION_MS));
        // The exit transition queues behind expiry and observes its durable state write.
        child.send({ type: "test-exit" });
        const error = yield* Effect.promise(() => running);
        assert.instanceOf(error, Error);
        assert.match((error as Error).message, /Active child exited unexpectedly/);
        const state = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.isUndefined(state.probation);
        assert.isFalse(
          yield* f.fs.exists(f.path.join(f.root, "runtime", "db-backup", f.pending.id)),
        );
        assert.equal(state.update?.status, "committed");
        assert.equal(yield* f.fs.readFileString(f.dbPath), "committed writes");
      }),
  );

  it.effect.each([false, true])(
    "recovers the persisted probation across a launcher restart (expired: %s)",
    (expired) =>
      Effect.gen(function* () {
        const f = yield* healthFixture();
        const first = yield* f.start({ now: () => 1000 });
        yield* f.wait("test-committed");
        yield* Effect.promise(() => first.launcher.stop("SIGTERM"));
        const state = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(state.update?.status, "committed");
        assert.isDefined(state.probation);
        const restarted = yield* f.start({ now: () => 1000 + (expired ? PROBATION_MS : 1234) });
        const child = yield* f.wait("test-restarted");
        child.send({ type: "test-exit" });
        yield* Effect.promise(() => restarted.running);
        const final = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(final.update?.status, expired ? "committed" : "rolled-back");
        // A target restarted during probation is still this update, so rollback restores the
        // snapshot instead of leaving the old build on the migrated database.
        if (!expired)
          assert.equal(
            final.update?.status === "rolled-back" ? final.update.reason : undefined,
            "probation-exit:42",
          );
        assert.isFalse(
          yield* f.fs.exists(f.path.join(f.root, "runtime", "db-backup", f.pending.id)),
        );
        assert.equal(
          yield* f.fs.readFileString(f.dbPath),
          expired ? "committed writes" : "original database",
        );
      }),
  );

  it.effect("rolls back when the committed target cannot start after a launcher restart", () =>
    Effect.gen(function* () {
      const f = yield* healthFixture();
      const first = yield* f.start({ now: () => 1000 });
      yield* f.wait("test-committed");
      yield* Effect.promise(() => first.launcher.stop("SIGTERM"));
      // The committed build is no longer startable when the service comes back.
      yield* f.fs.remove(
        f.path.join(f.root, "runtime", "goat", "versions", "1.1.0", ".install-complete"),
      );
      const restarted = yield* f.start({ now: () => 1000 + 1234 });
      yield* Effect.promise(() => restarted.running.catch(() => undefined));
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        "probation-start-failed",
      );
      assert.isUndefined(state.probation);
      assert.equal(yield* f.fs.readFileString(f.dbPath), "original database");
    }),
  );
});

it.layer(NodeServices.layer)("probation exit ownership", (it) => {
  it.effect.each([0, "SIGTERM"] as const)("rolls back an unexpected probation exit %s", (exit) =>
    Effect.gen(function* () {
      const f = yield* healthFixture();
      const { running } = yield* f.start({ now: () => 1000 });
      const child = yield* f.wait("test-committed");
      child.send(exit === 0 ? { type: "test-exit", code: 0 } : { type: "test-signal" });
      yield* Effect.promise(() => running);
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(
        state.update?.status === "rolled-back" ? state.update.reason : undefined,
        `probation-exit:${exit}`,
      );
      assert.equal(yield* f.fs.readFileString(f.dbPath), "original database");
    }),
  );

  it.effect("honors a stop marker without rolling back committed writes", () =>
    Effect.gen(function* () {
      const f = yield* healthFixture();
      const { running } = yield* f.start({ now: () => 1000 });
      const child = yield* f.wait("test-committed");
      yield* f.fs.writeFileString(f.path.join(f.root, "runtime", SERVICE_STOP_MARKER_FILE), "");
      child.send({ type: "test-exit" });
      assert.isUndefined(yield* Effect.promise(() => running));
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(state.update?.status, "committed");
      assert.isDefined(state.probation);
      assert.equal(yield* f.fs.readFileString(f.dbPath), "committed writes");
    }),
  );

  it.effect(
    "keeps rollback intent across a busy owner, launcher restart and expired probation",
    () =>
      Effect.gen(function* () {
        const f = yield* healthFixture();
        let now = 1000;
        let probationDeadline: (() => void) | undefined;
        const retryScheduled = Promise.withResolvers<void>();
        const realSetTimeout = globalThis.setTimeout;
        const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
          callback: () => void,
          ms: number,
        ) => {
          // @effect-diagnostics-next-line globalTimers:off - This observes rollback retry registration without sleeping.
          const timer = realSetTimeout(callback, ms);
          if (ms === 5000) retryScheduled.resolve();
          if (ms === PROBATION_MS) probationDeadline = callback;
          return timer;
        }) as typeof setTimeout);
        yield* Effect.addFinalizer(() => Effect.sync(() => timerSpy.mockRestore()));
        const first = yield* f.start({ now: () => now });
        const child = yield* f.wait("test-committed");
        child.send({ type: "test-release" });
        yield* f.wait("test-released");
        let otherOwner = tryAcquireServerOwnerLock(
          f.path.dirname(f.dbPath),
          "desktop-other-server",
        );
        assert.isDefined(otherOwner);
        yield* Effect.addFinalizer(() => Effect.sync(() => otherOwner?.release()));
        yield* f.fs.writeFileString(f.dbPath, "other server writes");
        child.send({ type: "test-exit" });
        yield* Effect.promise(() => retryScheduled.promise);
        now += PROBATION_MS + 1;
        // Simulate an expiry callback that was already queued before the exit cancelled its timer.
        assert.isDefined(probationDeadline);
        probationDeadline!();
        yield* Effect.promise(() => first.launcher.stop("SIGTERM"));
        const interrupted = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(interrupted.probation?.rollbackReason, "probation-exit:42");
        assert.equal(interrupted.update?.status, "committed");
        otherOwner!.release();
        otherOwner = undefined;
        const recovered = yield* f.start({ now: () => 1000 + PROBATION_MS + 1 });
        yield* Effect.promise(() => recovered.running);
        const state = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(
          state.update?.status === "rolled-back" ? state.update.reason : undefined,
          "probation-exit:42;db-kept-for-other-server",
        );
        assert.isUndefined(state.probation);
        assert.equal(yield* f.fs.readFileString(f.dbPath), "other server writes");
      }),
  );
});

it("rejects invalid persisted probation and retains string-valued rollback reasons", () => {
  const committed = {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: "1.1.0",
    update: { id: "u", fromVersion: "1.0.0", targetVersion: "1.1.0", status: "committed" as const },
  };
  const probation = {
    dbPath: "/tmp/statev2.sqlite",
    deadline: 600_000,
    rollbackReason: "probation-exit:SIGTERM",
  };
  assert.deepEqual(decodeServiceState({ ...committed, probation }), { ...committed, probation });
  for (const invalid of [
    null,
    {},
    { ...probation, dbPath: "" },
    { ...probation, deadline: -1 },
    { ...probation, deadline: 1.5 },
    { ...probation, deadline: "later" },
    { ...probation, rollbackReason: "" },
  ]) {
    assert.isUndefined(decodeServiceState({ ...committed, probation: invalid }));
  }
  assert.isUndefined(
    decodeServiceState({
      ...committed,
      update: { ...committed.update, status: "rolled-back" },
      activeVersion: "1.0.0",
      probation,
    }),
  );
  for (const reason of [
    "smoke-failed:timeout",
    "probation-exit:42",
    "probation-exit:SIGTERM;db-kept-for-other-server",
  ]) {
    assert.deepEqual(
      decodeServiceState({
        ...committed,
        activeVersion: "1.0.0",
        update: { ...committed.update, status: "rolled-back", reason },
      })?.update,
      { ...committed.update, status: "rolled-back", reason },
    );
  }
});

it.layer(NodeServices.layer)("probation state-dir ownership", (it) => {
  it.effect("idles without rollback when the active child reports another owner", () =>
    Effect.gen(function* () {
      const f = yield* healthFixture();
      const { launcher, running } = yield* f.start({ now: () => 1000 });
      const child = yield* f.wait("test-committed");
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.send({ type: "test-exit", code: SERVER_EXIT_CODE_STATE_DIR_OWNED });
      yield* Effect.promise(() => exited);
      // The stop queues behind the already-observed exit transition, including its idle path.
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      assert.isUndefined(yield* Effect.promise(() => running));
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(state.update?.status, "committed");
      assert.isDefined(state.probation);
      assert.equal(yield* f.fs.readFileString(f.dbPath), "committed writes");
    }),
  );
});

it.layer(NodeServices.layer)("probation event deadline", (it) => {
  it.effect(
    "judges an exit at receipt even when its queued transition runs after the deadline",
    () =>
      Effect.gen(function* () {
        const f = yield* healthFixture();
        let now = 1000;
        const { running } = yield* f.start({ now: () => now });
        const child = yield* f.wait("test-committed");
        // Launcher registered first: its exit callback captures 1000, then the queue runs later.
        child.once("exit", () => {
          now += PROBATION_MS + 1;
        });
        child.send({ type: "test-exit" });
        yield* Effect.promise(() => running);
        const state = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(
          state.update?.status === "rolled-back" ? state.update.reason : undefined,
          "probation-exit:42",
        );
        assert.equal(yield* f.fs.readFileString(f.dbPath), "original database");
      }),
  );
});
