// @effect-diagnostics nodeBuiltinImport:off - observes launcher child IPC.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
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
    yield* fs.writeFileString(dbPath, "before trial");
    yield* writeFakeRuntime(
      fs,
      path,
      path.join(root, "runtime", "goat", "versions", "1.0.0"),
      `
process.on("message", (message) => {
  if (message.type === "test-request") {
    process.send({ type: "request-update", targetVersion: "1.1.0", dbPath: ${JSON.stringify(dbPath)} });
  } else {
    process.send(message.type);
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
    return { fs, dbPath, statePath, targetDir, start, notice, notices };
  });

it.layer(NodeServices.layer)("service update disk headroom", (it) => {
  it.effect.each(["before acknowledgement", "at handoff"] as const)(
    "keeps the active server running when disk space drops %s",
    (when) =>
      Effect.gen(function* () {
        const f = yield* makeFixture(false);
        let free = when === "at handoff" ? headroom : 0;
        const held = Promise.withResolvers<"disk-hold">();
        const running = yield* f.start({
          startupSpaceProbe: async (directory) => (directory === f.targetDir ? free : headroom),
          writeDiagnostic: () => held.resolve("disk-hold"),
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
        assert.equal(response, when === "at handoff" ? "accepted" : "rejected");
        if (when === "at handoff") {
          free = 0;
          assert.equal(
            yield* Effect.promise(() => Promise.race([held.promise, running.running])),
            "disk-hold",
          );
        }
        assert.isNull(active.exitCode);
        assert.isNull(active.signalCode);
        assert.isTrue(active.connected);
      }),
  );

  it.effect("recovers rollback after restarting a launcher parked for disk space", () =>
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
      yield* Effect.promise(() => first.launcher.stop("SIGTERM"));
      yield* Effect.promise(() => first.running);

      f.notices.delete("candidate");
      const recovered = yield* f.start({ startupSpaceProbe: async () => headroom });
      const restarted = yield* Effect.promise(() =>
        Promise.race([
          f.notice("active").promise.then(() => "active"),
          f.notice("candidate").promise.then(() => "candidate"),
          recovered.running,
        ]),
      );
      assert.equal(restarted, "active");
      assert.equal(yield* f.fs.readFileString(f.dbPath), "before trial");
      const state = yield* Effect.promise(() => readServiceState(f.statePath));
      assert.equal(state.activeVersion, "1.0.0");
      assert.equal(state.update?.status, "failed");
    }),
  );
});
