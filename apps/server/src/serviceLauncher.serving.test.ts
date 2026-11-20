// @effect-diagnostics nodeBuiltinImport:off -- This test observes the real launcher child and SQLite lease.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import type * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { Launcher, readServiceState, writeServiceState } from "./serviceLauncher.ts";
import { seedDatabase, writeFakeRuntime } from "./serviceLauncher.testkit.ts";

const observed = vi.hoisted(() => ({
  child: undefined as ((child: NodeChildProcess.ChildProcess) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      observed.child?.(child);
      return child;
    }) as typeof actual.spawn,
  };
});

it.live(
  "a boot launcher owns its serving lease before the server starts and releases it on stop",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-serving-" });
      const state = path.join(root, "runtime", "service-state.json");
      yield* writeFakeRuntime(
        fs,
        path,
        path.join(root, "runtime", "goat", "versions", "1.0.0"),
        "setInterval(() => {}, 1000);",
      );
      yield* Effect.promise(() =>
        writeServiceState(state, { protocol: SERVICE_LAUNCHER_PROTOCOL, activeVersion: "1.0.0" }),
      );
      const spawned = Promise.withResolvers<void>();
      observed.child = (child) => child.once("spawn", () => spawned.resolve());
      const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(state)));
      const running = launcher.run();
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          observed.child = undefined;
          await launcher.stop("SIGTERM");
          await running;
        }),
      );
      yield* Effect.promise(() => spawned.promise);
      const lease = path.join(root, "runtime", "service-serving.lock");
      assert.isTrue(NodeFS.existsSync(lease));
      const probe = new NodeSqlite.DatabaseSync(lease);
      try {
        assert.throws(() => probe.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"));
      } finally {
        probe.close();
      }
      yield* Effect.promise(() => launcher.stop("SIGTERM"));
      const free = new NodeSqlite.DatabaseSync(lease);
      try {
        free.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
      } finally {
        free.close();
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("removes the handoff marker when a pending update cannot start", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-handoff-" });
    const state = path.join(root, "runtime", "service-state.json");
    const db = path.join(root, "userdata", "statev2.sqlite");
    yield* fs.makeDirectory(path.dirname(db), { recursive: true });
    seedDatabase(db, "original");
    yield* writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime", "goat", "versions", "1.0.0"),
      'process.send({type:"restored"}); setInterval(() => {}, 1000);',
    );
    yield* Effect.promise(() =>
      writeServiceState(state, {
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        activeVersion: "1.0.0",
        update: {
          id: "missing-update",
          fromVersion: "1.0.0",
          targetVersion: "1.1.0",
          dbPath: db,
          status: "pending",
        },
      }),
    );
    const marker = path.join(root, "runtime", "service-update-handoff.json");
    yield* fs.writeFileString(marker, JSON.stringify({ generation: "missing-update" }));
    const restored = Promise.withResolvers<void>();
    observed.child = (child) =>
      child.on("message", (value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          value.type === "restored"
        )
          restored.resolve();
      });
    const launcher = new Launcher(root, yield* Effect.promise(() => readServiceState(state)));
    const running = launcher.run();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        observed.child = undefined;
        await launcher.stop("SIGTERM");
        await running;
      }),
    );
    yield* Effect.promise(() => restored.promise);
    assert.isFalse(yield* fs.exists(marker));
    const result = yield* Effect.promise(() => readServiceState(state));
    assert.equal(result.update?.status, "failed");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
