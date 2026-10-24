import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as HostProcess from "@goat/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "goat-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

interface LockedRenames {
  remaining: number;
  attempts: number;
  /** Completed by the first refused rename, after which the store waits to retry. */
  locked: Deferred.Deferred<void>;
}

/** Renames fail with Windows' EPERM while `remaining` is above zero. */
const layerLockedRenameSecretStore = (platform: NodeJS.Platform, lockedRenames: LockedRenames) =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(layerServerConfig()),
    Layer.provideMerge(
      Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return {
            ...fileSystem,
            rename: (from, to) =>
              Effect.gen(function* () {
                lockedRenames.attempts += 1;
                if (lockedRenames.remaining <= 0) return yield* fileSystem.rename(from, to);
                lockedRenames.remaining -= 1;
                yield* Deferred.succeed(lockedRenames.locked, undefined);
                return yield* PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: `${String(from)} -> ${String(to)}`,
                  cause: Object.assign(new Error("EPERM: operation not permitted, rename"), {
                    code: "EPERM",
                  }),
                });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
  );

const temporaryFiles = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  return (yield* fileSystem.readDirectory(secretsDir)).filter((name) => name.endsWith(".tmp"));
});

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("rides out a Windows rename lock and never leaves a partial secret", () => {
    const lockedRenames: LockedRenames = {
      remaining: 0,
      attempts: 0,
      locked: Deferred.makeUnsafe(),
    };
    return Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const read = secretStore.get("handoff").pipe(Effect.map(Option.map((v) => Array.from(v))));
      yield* secretStore.set("handoff", Uint8Array.from([1]));

      // A reader or scanner holding the secret open clears after a few attempts.
      lockedRenames.remaining = 3;
      const replaced = yield* Effect.forkChild(secretStore.set("handoff", Uint8Array.from([2])));
      yield* Deferred.await(lockedRenames.locked);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(replaced);
      assert.deepEqual(yield* read, Option.some([2]));
      assert.deepEqual(yield* temporaryFiles, []);

      // A denial that never clears fails after a bounded wait and keeps the last secret.
      lockedRenames.remaining = Number.POSITIVE_INFINITY;
      lockedRenames.attempts = 0;
      lockedRenames.locked = Deferred.makeUnsafe();
      const denied = yield* Effect.forkChild(
        Effect.flip(secretStore.set("handoff", Uint8Array.from([3]))),
      );
      yield* Deferred.await(lockedRenames.locked);
      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(denied);
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.equal(lockedRenames.attempts, 21);
      assert.deepEqual(yield* read, Option.some([2]));
      assert.deepEqual(yield* temporaryFiles, []);
    }).pipe(Effect.provide(layerLockedRenameSecretStore("win32", lockedRenames)));
  });

  it.effect("fails a POSIX rename denial without waiting", () => {
    const lockedRenames: LockedRenames = {
      remaining: 1,
      attempts: 0,
      locked: Deferred.makeUnsafe(),
    };
    return Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const error = yield* Effect.flip(secretStore.set("handoff", Uint8Array.from([1])));
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.equal(lockedRenames.attempts, 1);
    }).pipe(Effect.provide(layerLockedRenameSecretStore("linux", lockedRenames)));
  });
});
