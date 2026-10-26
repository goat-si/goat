import * as NodeServices from "@effect/platform-node/NodeServices";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Runtime from "effect/Runtime";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";

import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import { acquireServerOwnerLock, serverOwnerTag } from "./serverOwnerLock.ts";
import { tryAcquireServerOwnerLock } from "./serverOwnerLockFile.ts";

const pendingUpdate = {
  id: "update-1",
  fromVersion: "1.0.0",
  targetVersion: "1.1.0",
  dbPath: "/data/userdata/statev2.sqlite",
  status: "pending",
} as const;

describe("server owner lock", () => {
  it("tags a launcher trial so its rollback can tell its own writes apart", () => {
    const trial = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.1.0",
      update: pendingUpdate,
    };
    assert.equal(serverOwnerTag({ launcherContext: trial, mode: "web" }), "service-trial:update-1");
    const active = {
      protocol: SERVICE_LAUNCHER_PROTOCOL,
      childVersion: "1.1.0",
      update: { ...pendingUpdate, status: "committed" as const },
    };
    assert.equal(serverOwnerTag({ launcherContext: active, mode: "web" }), "service:1.1.0");
    // A committed target the launcher restarts during probation is still that update.
    assert.equal(
      serverOwnerTag({ launcherContext: { ...active, probation: true }, mode: "web" }),
      "service-probation:update-1",
    );
    assert.equal(serverOwnerTag({ launcherContext: undefined, mode: "desktop" }), "server:desktop");
  });

  it.effect("holds the lock for the scope and records the owner in the generation log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const before = tryAcquireServerOwnerLock(stateDir, "service-launcher:update-1");
      assert.isDefined(before);
      const backupGeneration = before!.generation;
      before!.release();

      const scope = yield* Scope.make();
      yield* acquireServerOwnerLock({
        stateDir,
        owner: "server:desktop",
        serverRuntimeStatePath: `${stateDir}/server-runtime.json`,
        waitForOwner: false,
      }).pipe(Scope.provide(scope));
      assert.isUndefined(tryAcquireServerOwnerLock(stateDir, "service-launcher:update-1"));

      yield* Scope.close(scope, Exit.void);
      const after = tryAcquireServerOwnerLock(stateDir, "service-launcher:update-1");
      assert.isDefined(after);
      // The launcher sees the desktop server that owned the data since its backup.
      assert.deepEqual(after!.ownersSince(backupGeneration), [
        "server:desktop",
        "service-launcher:update-1",
      ]);
      after!.release();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "fails a server outside the service once the handoff grace runs out, with the exit code the desktop stops restarting on",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped();
        const holder = tryAcquireServerOwnerLock(stateDir, "service:1.0.0")!;
        yield* fs.writeFileString(
          `${stateDir}/server-runtime.json`,
          JSON.stringify({
            version: 1,
            pid: 4242,
            port: 3773,
            host: "127.0.0.1",
            origin: "http://127.0.0.1:3773",
            startedAt: "2026-10-13T00:00:00.000Z",
          }),
        );
        const fiber = yield* acquireServerOwnerLock({
          stateDir,
          owner: "server:desktop",
          serverRuntimeStatePath: `${stateDir}/server-runtime.json`,
          waitForOwner: false,
          handoffGrace: Duration.seconds(2),
          pollInterval: Duration.seconds(1),
        }).pipe(Effect.flip, Effect.forkScoped);
        yield* TestClock.adjust(Duration.seconds(2));
        const error = yield* Fiber.join(fiber);
        holder.release();
        assert.equal(error._tag, "ServerOwnerConflictError");
        assert.include(
          error.message,
          `Another GOAT server is using ${stateDir} (pid 4242, http://127.0.0.1:3773).`,
        );
        // The desktop restarts any other exit, so a second app on the same data respawned forever.
        assert.strictEqual(Runtime.getErrorExitCode(error), SERVER_EXIT_CODE_STATE_DIR_OWNED);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("makes a service-managed server wait until the owner exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const holder = tryAcquireServerOwnerLock(stateDir, "server:desktop")!;
      const fiber = yield* acquireServerOwnerLock({
        stateDir,
        owner: "service-trial:update-1",
        serverRuntimeStatePath: `${stateDir}/server-runtime.json`,
        waitForOwner: true,
        handoffGrace: Duration.zero,
        pollInterval: Duration.seconds(1),
      }).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.minutes(5));
      assert.isUndefined(fiber.pollUnsafe());
      holder.release();
      yield* TestClock.adjust(Duration.seconds(1));
      const generation = yield* Fiber.join(fiber);
      assert.isAbove(generation, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
