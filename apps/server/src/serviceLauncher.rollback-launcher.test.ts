// @effect-diagnostics nodeBuiltinImport:off -- Observes the real launcher child during rollback.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
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

it.live("rollback to an older runtime restores a legacy launcher link", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-rollback-launcher-" });
    const state = path.join(root, "runtime", "service-state.json");
    const db = path.join(root, "userdata", "statev2.sqlite");
    yield* fs.makeDirectory(path.dirname(db), { recursive: true });
    seedDatabase(db, "original");
    const old = yield* writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime/goat/versions/1.0.0"),
      'if (process.argv[2] === "__ssh-helper") process.exit(1); process.send({type:"restored"}); setInterval(() => {}, 1000);',
    );
    const newer = path.join(root, "runtime/goat/versions/1.1.0/goat");
    yield* fs.makeDirectory(path.dirname(newer), { recursive: true });
    yield* fs.writeFileString(newer, "incomplete runtime", { mode: 0o755 });
    const launcher = path.join(root, "bin/goat");
    yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
    yield* fs.writeFileString(launcher, `#!/bin/sh\nexec '${newer}' "$@"\n`, { mode: 0o755 });
    yield* fs.writeFileString(path.join(root, "runtime/launchers"), `${launcher}\n`);
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
    const manager = new Launcher(root, yield* Effect.promise(() => readServiceState(state)));
    const running = manager.run();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        observed.child = undefined;
        await manager.stop("SIGTERM");
        await running;
      }),
    );
    yield* Effect.promise(() => restored.promise);
    assert.equal(yield* fs.readLink(launcher), old);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
