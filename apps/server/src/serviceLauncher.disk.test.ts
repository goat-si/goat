// @effect-diagnostics nodeBuiltinImport:off - observes launcher child IPC.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as HostProcess from "@goat/shared/HostProcess";
import * as NodeSqlite from "node:sqlite";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { makeHarness } from "./cloud/selfUpdate.testkit.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./cloud/serviceProtocol.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { writeFakeRuntime } from "./serviceLauncher.testkit.ts";

const observeChild = vi.hoisted(() => ({
  spawned: undefined as ((child: NodeChildProcess.ChildProcess) => void) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    observeChild.spawned?.(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const headroom = 1024 ** 3;

const makeFixture = (pendingUpdate: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-disk-check-" });
    const dbPath = path.join(root, "userdata", "statev2.sqlite");
    const statePath = path.join(root, "runtime", "service-state.json");
    const targetDir = path.join(root, "runtime", "goat", "versions", "1.1.0");
    yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
    yield* Effect.sync(() => {
      using database = new NodeSqlite.DatabaseSync(dbPath);
      database.exec(
        "CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('before trial')",
      );
    });
    const original = yield* fs.readFile(dbPath);
    yield* writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime", "goat", "versions", "1.0.0"),
      `
process.on("message", (message) => {
  if (message.type === "test-request") {
    process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(dbPath)} });
  } else if (message.type === "test-ipc") {
    process.send(message.request);
  } else {
    process.send(message.type);
    process.send({ reply: message });
  }
});
process.send("active");
`,
    );
    yield* writeFakeRuntime(
      fs,
      path,
      targetDir,
      `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dbPath)}, "failed candidate");
process.on("message", () => process.exit(17));
process.send("candidate");
`,
    );
    yield* Effect.promise(() =>
      writeServiceState(statePath, {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        ...(pendingUpdate
          ? {
              update: {
                id: "disk-test",
                fromVersion: "1.0.0",
                targetVersion: "1.1.0",
                dbPath,
                status: "pending" as const,
              },
            }
          : {}),
      }),
    );
    const notices = new Map<
      string,
      ReturnType<typeof Promise.withResolvers<NodeChildProcess.ChildProcess>>
    >();
    const notice = (type: string) => {
      const existing = notices.get(type);
      if (existing) return existing;
      const next = Promise.withResolvers<NodeChildProcess.ChildProcess>();
      notices.set(type, next);
      return next;
    };
    observeChild.spawned = (child) =>
      child.on("message", (message) => {
        if (typeof message === "string") notice(message).resolve(child);
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        observeChild.spawned = undefined;
      }),
    );
    const start = Effect.fn("test.serviceLauncher.start")(function* (
      options: ConstructorParameters<typeof Launcher>[2],
    ) {
      const launcher = new Launcher(
        root,
        yield* Effect.promise(() => readServiceState(statePath)),
        options,
      );
      const running = launcher.run().catch((error: unknown) => error);
      yield* Effect.addFinalizer(() => Effect.promise(() => launcher.stop("SIGTERM")));
      return { launcher, running };
    });
    return { fs, path, root, dbPath, original, statePath, targetDir, start, notice, notices };
  });

const makeIpcClient = (child: NodeChildProcess.ChildProcess) =>
  Effect.gen(function* () {
    const replies = new NodeEvents.EventEmitter();
    child.on("message", (message) => {
      if (typeof message === "object" && message !== null && "reply" in message) {
        replies.emit("message", message.reply);
      }
    });
    child.on("disconnect", () => replies.emit("disconnect"));
    return yield* ServiceLauncherClient.make({ currentVersion: "1.0.0" }).pipe(
      Effect.provideService(ServiceLauncherClient.ServiceLauncherHostProcess, {
        get connected() {
          return child.connected;
        },
        send: (request, callback) => child.send({ type: "test-ipc", request }, callback),
        on: (event, listener) => {
          replies.on(event, listener);
        },
        off: (event, listener) => {
          replies.off(event, listener);
        },
      }),
      Effect.provideService(HostProcess.Environment, {
        [SERVICE_LAUNCHER_CONTEXT_ENV]: JSON.stringify({
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          childVersion: "1.0.0",
        }),
      }),
    );
  });

it.layer(NodeServices.layer)("service update disk headroom", (it) => {
  it.effect(
    "rejects low startup headroom before accepting and keeps the active server running",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture(false);
        const running = yield* f.start({
          startupSpaceProbe: async (directory) => (directory === f.targetDir ? 0 : headroom),
        });
        const active = yield* Effect.promise(() => f.notice("active").promise);
        active.send({ type: "test-request" });
        const response = yield* Effect.promise(() =>
          Promise.race([
            f.notice("update-accepted").promise.then(() => "accepted"),
            f.notice("update-rejected").promise.then(() => "rejected"),
            running.running,
          ]),
        );
        assert.equal(response, "rejected");
        assert.isNull(active.exitCode);
        assert.isNull(active.signalCode);
        assert.isTrue(active.connected);
      }),
  );

  it.effect.each(["startup", "backup"] as const)(
    "rejects the delayed handoff over launcher IPC and reopens admission when %s capacity drops",
    (space) =>
      Effect.gen(function* () {
        const f = yield* makeFixture(false);
        let targetProbes = 0;
        let backupProbes = 0;
        const activeLauncher = yield* f.start({
          startupSpaceProbe: async (directory) =>
            space === "startup" && directory === f.targetDir && ++targetProbes > 1 ? 0 : headroom,
          backupSpaceProbe: {
            readFreeBytes: async () => (space === "backup" && ++backupProbes > 1 ? 0 : headroom),
            canClone: async () => false,
          },
        });
        const active = yield* Effect.promise(() => f.notice("active").promise);
        const client = yield* makeIpcClient(active);
        const { selfUpdate, admission } = yield* makeHarness({
          baseDir: f.root,
          requestUpdate: client.requestUpdate,
        }).pipe(Effect.provide(NodeCrypto.layer));
        const outcome = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.exit);

        assert.isTrue(active.connected);
        assert.deepEqual(
          yield* admission.admit(Effect.succeed("new work")).pipe(Effect.exit),
          Exit.succeed("new work"),
        );
        assert.isTrue(Exit.isFailure(outcome));
        if (Exit.isFailure(outcome)) {
          const reason = String(Cause.squash(outcome.cause));
          assert.include(reason, "The server was not stopped");
          assert.include(reason, space === "backup" ? "back up the database" : "bytes available");
        }
        assert.isFalse(yield* selfUpdate.isUpdating);
        assert.isUndefined((yield* Effect.promise(() => readServiceState(f.statePath))).update);
        yield* Effect.promise(() => activeLauncher.launcher.stop("SIGTERM"));
      }),
  );

  it.effect(
    "preserves a failed trial and refuses to relaunch it after a restart during a disk hold",
    () =>
      Effect.gen(function* () {
        const f = yield* makeFixture(true);
        let free = headroom;
        const parked = Promise.withResolvers<"disk-hold">();
        const first = yield* f.start({
          startupSpaceProbe: async () => free,
          writeDiagnostic: () => parked.resolve("disk-hold"),
        });
        const candidate = yield* Effect.promise(() => f.notice("candidate").promise);
        free = 0;
        candidate.send("fail");
        assert.equal(
          yield* Effect.promise(() => Promise.race([parked.promise, first.running])),
          "disk-hold",
        );
        const phase = f.path.join(f.root, "runtime", "db-update-disk-test.phase");
        assert.equal((yield* f.fs.readFileString(phase)).trim(), "trial");
        yield* Effect.promise(() => first.launcher.stop("SIGTERM"));
        yield* Effect.promise(() => first.running);

        f.notices.delete("candidate");
        const recovered = yield* f.start({ startupSpaceProbe: async () => free });
        const restarted = yield* Effect.promise(() =>
          Promise.race([
            f.notice("active").promise.then(() => "active"),
            f.notice("candidate").promise.then(() => "candidate"),
            recovered.running,
          ]),
        );
        assert.instanceOf(restarted, Error);
        assert.include((restarted as Error).message, "No continuous ownership proof");
        assert.equal(yield* f.fs.readFileString(f.dbPath), "failed candidate");
        const backup = f.path.join(f.root, "runtime", "db-backup", "disk-test", "database");
        assert.deepEqual(yield* f.fs.readFile(backup), f.original);
        const state = yield* Effect.promise(() => readServiceState(f.statePath));
        assert.equal(state.activeVersion, "1.0.0");
        assert.equal(state.update?.status, "pending");
        assert.equal((yield* f.fs.readFileString(phase)).trim(), "trial");
      }),
  );

  it.effect("selects the verified old runtime if disk space drops after taking the snapshot", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture(true);
      const parked = Promise.withResolvers<"disk-hold">();
      let targetProbes = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const { running } = yield* f.start({
        startupSpaceProbe: async (directory) =>
          directory === f.targetDir && ++targetProbes > 1 ? 0 : headroom,
        writeDiagnostic: () => parked.resolve("disk-hold"),
      });
      assert.equal(
        yield* Effect.promise(() => Promise.race([parked.promise, running])),
        "disk-hold",
      );
      const phase = f.path.join(f.root, "runtime", "db-update-disk-test.phase");
      assert.equal((yield* f.fs.readFileString(phase)).trim(), "trial");

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(30_000));
      assert.equal(
        yield* Effect.promise(() =>
          Promise.race([
            f.notice("active").promise.then(() => "active"),
            f.notice("candidate").promise.then(() => "candidate"),
            running,
          ]),
        ),
        "active",
      );
      assert.deepEqual(yield* f.fs.readFile(f.dbPath), f.original);
      assert.equal(
        (yield* Effect.promise(() => readServiceState(f.statePath))).update?.status,
        "failed",
      );
    }),
  );
});
