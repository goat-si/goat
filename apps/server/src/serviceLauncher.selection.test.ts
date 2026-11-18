// @effect-diagnostics nodeBuiltinImport:off - fake runtimes and unit files are plain files.
import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  decodeServiceLauncherContext,
  SERVICE_LAUNCHER_GUARANTEES,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceState,
} from "./cloud/serviceProtocol.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { backupDatabaseOnce, launcherOwner } from "./serviceLauncherDatabase.ts";
import { repointServiceUnitContents, type ServiceUnit } from "./serviceUnitRepoint.ts";

const update = { id: "update-1", fromVersion: "1.0.0", targetVersion: "1.1.0" } as const;

// What goat v0.1.10's decodeServiceLauncherContext (apps/server/src/cloud/serviceProtocol.ts)
// checks: protocol must be 3 and childVersion the version it is; it reads no other key.
const shippedProtocol3Runtime = (marker: string) => `
import { writeFileSync } from "node:fs";
const context = JSON.parse(process.env.GOAT_SERVICE_LAUNCHER_CONTEXT);
const accepted = context.protocol === 3 && context.childVersion === "1.0.0";
writeFileSync(${JSON.stringify(marker)}, accepted ? "started" : "refused the launcher context");
process.exit(accepted ? 0 : 1);
`;

const makeHome = (state: ServiceState) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-selection-" });
    const statePath = path.join(root, "runtime", "service-state.json");
    yield* Effect.promise(() => writeServiceState(statePath, state));
    const runtime = (version: string, source: string) =>
      writeFakeRuntime(fs, path, path.join(root, "runtime", "goat", "versions", version), source);
    return { fs, path, root, statePath, runtime };
  });

/** Runs a launcher until its active child exits, which ends these scenarios. */
const runUntilActiveExits = (root: string, statePath: string, serviceUnit?: ServiceUnit) =>
  Effect.gen(function* () {
    const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(statePath)), {
      now: () => 0,
      ...(serviceUnit === undefined ? {} : { serviceUnit }),
    });
    yield* Effect.promise(() =>
      launcher.run().then(
        () => Promise.reject(new Error("launcher unexpectedly completed")),
        () => Promise.resolve(),
      ),
    );
    return yield* Effect.promise(() => readServiceState(statePath));
  });

const systemdUnit = (root: string, version: string, home = root) =>
  [
    "[Service]",
    `Environment=GOAT_HOME=${home}`,
    `ExecStart=${root}/runtime/goat/versions/${version}/goat __service-launcher`,
    "",
  ].join("\n");

it("tells children its guarantees in a field protocol-3 decoders ignore", () => {
  const fromNewLauncher = decodeServiceLauncherContext(
    JSON.stringify({
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      launcherProtocol: SERVICE_LAUNCHER_GUARANTEES,
      childVersion: "1.1.0",
    }),
  );
  assert.deepEqual(fromNewLauncher, { protocol: 3, launcherProtocol: 4, childVersion: "1.1.0" });
  // A protocol-3 launcher sends no launcherProtocol; this runtime still runs under it.
  assert.deepEqual(
    decodeServiceLauncherContext(JSON.stringify({ protocol: 3, childVersion: "1.1.0" })),
    {
      protocol: 3,
      childVersion: "1.1.0",
    },
  );
  // The context format itself stays protocol 3.
  assert.isUndefined(
    decodeServiceLauncherContext(JSON.stringify({ protocol: 4, childVersion: "1.1.0" })),
  );
});

it("points a unit or launch agent at the selected runtime, never at an older one", () => {
  const root = "/home/sam/.goat";
  assert.equal(
    repointServiceUnitContents(systemdUnit(root, "1.0.0"), "1.1.0"),
    systemdUnit(root, "1.1.0"),
  );
  assert.equal(
    repointServiceUnitContents(systemdUnit(root, "1.2.0"), "1.1.0"),
    systemdUnit(root, "1.2.0"),
  );
  const quoted =
    'ExecStart="/home/sam/my goat/runtime/goat/versions/1.0.0/goat" __service-launcher\n';
  assert.equal(
    repointServiceUnitContents(quoted, "1.1.0"),
    'ExecStart="/home/sam/my goat/runtime/goat/versions/1.1.0/goat" __service-launcher\n',
  );
  const plist = (version: string) =>
    `<key>ProgramArguments</key>\n  <array>\n    <string>/Users/sam/.goat/runtime/goat/versions/${version}/goat</string>\n    <string>__service-launcher</string>\n  </array>\n`;
  assert.equal(repointServiceUnitContents(plist("1.0.0"), "1.1.0"), plist("1.1.0"));
});

it.layer(NodeServices.layer)("launcher selection and unit", (it) => {
  it.effect(
    "a probation rollback under a restarted new launcher starts the protocol-3 runtime it returns to",
    () =>
      Effect.gen(function* () {
        // The service restarted during probation, so the unit already runs the new launcher.
        const committed = {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "1.1.0",
          update: { ...update, status: "committed" as const },
        };
        const home = yield* makeHome(committed);
        const stateDir = home.path.join(home.root, "userdata");
        const dbPath = home.path.join(stateDir, "state.sqlite");
        yield* home.fs.makeDirectory(stateDir);
        yield* home.fs.writeFileString(dbPath, "before trial");
        const lock = tryAcquireServerOwnerLock(stateDir, launcherOwner(update.id));
        assert.isDefined(lock);
        try {
          yield* Effect.promise(() =>
            backupDatabaseOnce(
              home.root,
              { ...update, status: "pending", dbPath },
              lock.generation,
              new AbortController().signal,
            ),
          );
        } finally {
          lock.release();
        }
        yield* home.fs.writeFileString(dbPath, "after trial");
        yield* Effect.promise(() =>
          writeServiceState(home.statePath, {
            ...committed,
            probation: { dbPath, deadline: 60_000 },
          }),
        );
        const marker = home.path.join(home.root, "protocol-3-runtime.txt");
        yield* home.runtime("1.0.0", shippedProtocol3Runtime(marker));
        yield* home.runtime("1.1.0", "process.exit(1);");
        const state = yield* runUntilActiveExits(home.root, home.statePath);
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "rolled-back");
        assert.equal(yield* home.fs.readFileString(dbPath), "before trial");
        assert.equal(yield* home.fs.readFileString(marker), "started");
        // Durable state stays readable by a protocol-3 launcher.
        assert.equal(JSON.parse(yield* home.fs.readFileString(home.statePath)).protocol, 3);
      }),
  );

  const reloads: Array<string> = [];
  const unitAt = (unitPath: string): ServiceUnit => ({
    path: unitPath,
    reload: () => {
      reloads.push(unitPath);
      return Promise.resolve();
    },
  });

  it.effect("a start after a finished update points the unit at the selected runtime", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.1.0",
        update: { ...update, status: "committed" },
      });
      yield* home.runtime("1.1.0", "process.exit(0);");
      const unitPath = home.path.join(home.root, "goat.service");
      yield* home.fs.writeFileString(unitPath, systemdUnit(home.root, "1.0.0"));
      yield* runUntilActiveExits(home.root, home.statePath, unitAt(unitPath));
      assert.equal(yield* home.fs.readFileString(unitPath), systemdUnit(home.root, "1.1.0"));
      assert.include(reloads, unitPath);
    }),
  );

  it.effect("leaves a unit that serves another home alone", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.1.0",
        update: { ...update, status: "committed" },
      });
      yield* home.runtime("1.1.0", "process.exit(0);");
      const unitPath = home.path.join(home.root, "goat.service");
      const other = systemdUnit(home.root, "1.0.0", "/home/someone-else/.goat");
      yield* home.fs.writeFileString(unitPath, other);
      yield* runUntilActiveExits(home.root, home.statePath, unitAt(unitPath));
      assert.equal(yield* home.fs.readFileString(unitPath), other);
    }),
  );

  it.effect("refuses an update once a local install changed the selection", () =>
    Effect.gen(function* () {
      const home = yield* makeHome({ protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.0.0" });
      const replyPath = home.path.join(home.root, "reply.txt");
      const dbPath = home.path.join(home.root, "state.sqlite");
      yield* home.fs.writeFileString(dbPath, "database");
      const source = `
import { writeFileSync } from "node:fs";
process.on("message", (message) => {
  writeFileSync(${JSON.stringify(replyPath)}, message.type === "update-rejected" ? message.reason : message.type);
  process.exit(0);
});
// A local install with a deferred restart rewrote the selection while this server runs.
writeFileSync(${JSON.stringify(home.statePath)}, JSON.stringify({ protocol: 3, activeVersion: "1.2.0" }));
process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(dbPath)} });
setInterval(() => {}, 1_000);
`;
      yield* home.runtime("1.0.0", source);
      yield* home.runtime("1.1.0", "process.exit(0);");
      yield* runUntilActiveExits(home.root, home.statePath);
      assert.equal(
        yield* home.fs.readFileString(replyPath),
        "Service selection changed. Restart the service before updating.",
      );
      assert.deepEqual(yield* Effect.promise(() => readServiceState(home.statePath)), {
        protocol: 3,
        activeVersion: "1.2.0",
      });
    }),
  );
});
