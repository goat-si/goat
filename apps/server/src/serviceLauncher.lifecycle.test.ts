// @effect-diagnostics nodeBuiltinImport:off -- These lifecycle tests drive real temporary subprocesses.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@goat/shared/HostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import { vi } from "vite-plus/test";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { Launcher, main, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";

const spawnedChildren = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawnedChildren.push(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

it.layer(NodeServices.layer)("service launcher lifecycle", (it) => {
  it.effect("starts the runtime in a GOAT home whose name ends in a space", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-space-" });
      const root = path.join(parent, "GOAT data ");
      const versionDir = path.join(root, "runtime", "goat", "versions", "1.0.0");
      yield* writeFakeRuntime(
        fs,
        path,
        versionDir,
        `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./started", import.meta.url), "");
process.exit(0);`,
      );
      yield* Effect.promise(() =>
        writeServiceState(path.join(root, "runtime", "service-state.json"), {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.0.0",
        }),
      );
      vi.stubEnv("GOAT_HOME", root);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const failure = yield* Effect.promise(() =>
        main().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      assert.include(String(failure), "Active child exited unexpectedly (0).");
      assert.isTrue(yield* fs.exists(path.join(versionDir, "started")));
    }),
  );

  it.effect("stopping during a blocked backup copy terminates it without starting the trial", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-blocked-copy-" });
      const fifo = path.join(root, "copy-started");
      const bin = path.join(root, "bin");
      yield* fs.makeDirectory(bin);
      const mkfifo = NodeChildProcess.spawnSync("/usr/bin/mkfifo", [fifo]);
      assert.equal(mkfifo.status, 0);
      yield* fs.writeFileString(
        path.join(bin, "cp"),
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(fifo)}, "started");\nprocess.stdin.resume();\n`,
        { mode: 0o755 },
      );
      const dbPath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      yield* fs.writeFileString(dbPath, "database");
      const statePath = path.join(root, "runtime", "service-state.json");
      const pending = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "update-1",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending",
        },
      } as const;
      for (const version of ["1.0.0", "1.1.0"])
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", version),
          "process.exit(0);\n",
        );
      yield* Effect.promise(() => writeServiceState(statePath, pending));
      vi.stubEnv("PATH", bin);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const count = spawnedChildren.length;
      const launcher = new Launcher(root, pending);
      const running = launcher.run();
      yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
      assert.equal(yield* Effect.promise(() => NodeFSP.readFile(fifo, "utf8")), "started");
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);
      assert.equal(spawnedChildren.length, count);
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), pending);
      assert.isFalse(yield* fs.exists(path.join(root, "runtime", "db-backup", "update-1.staging")));
    }),
  );

  it.effect("starts no trial when stopped during the pre-update backup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-backup-stop-" });
      const statePath = path.join(root, "runtime", "service-state.json");
      const childSource = "setInterval(() => {}, 1000);\n";
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* writeFakeRuntime(
          fs,
          path,
          path.join(root, "runtime", "goat", "versions", version),
          childSource,
        );
      }
      const dbPath = path.join(root, "userdata", "state.sqlite");
      yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
      yield* fs.writeFileString(dbPath, "database");
      const pending = {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "update-1",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath,
          status: "pending",
        },
      } as const;
      yield* Effect.promise(() => writeServiceState(statePath, pending));
      const childCount = spawnedChildren.length;
      const launcher = new Launcher(root, pending);

      // Recovery is already queued, so this stop lands while the backup runs.
      const running = launcher.run();
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      yield* Effect.promise(() => running);

      // A trial started here arms its 30-minute prepared timer, which keeps the stopped launcher alive.
      assert.deepEqual(
        spawnedChildren.slice(childCount).map((child) => child.spawnargs.join(" ")),
        [],
      );
      assert.deepEqual(yield* Effect.promise(() => readServiceState(statePath)), pending);
      const backupDir = path.join(root, "runtime", "db-backup", "update-1");
      assert.isFalse(yield* fs.exists(backupDir));
      assert.isFalse(yield* fs.exists(`${backupDir}.staging`));
    }),
  );
});
