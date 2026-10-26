import * as PlatformError from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@goat/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSafeStorageSiblingKeys from "./DesktopSafeStorageSiblingKeys.ts";

const EXPIRED_LOCK_TIME = DateTime.toDateUtc(DateTime.makeUnsafe(-120_000));
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const VALID_CATALOG =
  '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[],"disabledEnvironmentIds":[]}';
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function layerSafeStorageFor(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

/**
 * Stands in for another channel's key: values written as `nightly:<plaintext>` decrypt with it.
 * Counts calls, since each real attempt can show a Keychain prompt.
 */
function layerSiblingKeysFor(
  calls: Ref.Ref<number> | null = null,
  whileDecrypting: Effect.Effect<void> = Effect.void,
) {
  return Layer.succeed(DesktopSafeStorageSiblingKeys.DesktopSafeStorageSiblingKeys, {
    decrypt: (ciphertext, accept) =>
      Effect.gen(function* () {
        if (calls !== null) yield* Ref.update(calls, (count) => count + 1);
        yield* whileDecrypting;
        const decoded = textDecoder.decode(ciphertext);
        const marker = decoded.indexOf("nightly:");
        if (marker < 0) return Option.none();
        const plaintext = decoded.slice(marker + "nightly:".length);
        return accept(plaintext)
          ? Option.some({ plaintext, runtimeName: "GOAT Nightly" })
          : Option.none();
      }),
  });
}

function layerFor(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  siblingCalls: Ref.Ref<number> | null = null,
  whileDecrypting: Effect.Effect<void> = Effect.void,
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ GOAT_HOME: baseDir })),
    ),
  );
  const layerSafeStorage = layerSafeStorageFor(encryptionAvailable, failDecrypt);
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    layerSiblingKeysFor(siblingCalls, whileDecrypting),
    NodeServices.layer,
    fileSystemLayer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

/** A catalog file another channel wrote, which this app's key cannot open. */
const writeSiblingCatalog = Effect.fn(function* (plaintext: string) {
  const path = yield* Path.Path;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  const raw = `${JSON.stringify({
    version: 1,
    encryptedCatalog: Base64.encode(textEncoder.encode(`nightly:${plaintext}`)),
  })}\n`;
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
  yield* fileSystem.writeFileString(catalogPath, raw);
  return { catalogPath, raw, stateDir: environment.stateDir };
});

const unreadableBackupPath = Effect.fn(function* (stateDir: string, raw: string) {
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", textEncoder.encode(raw));
  return path.join(
    stateDir,
    `connection-catalog.unreadable-${Hex.encode(digest).slice(0, 16)}.backup.json`,
  );
});

const withSiblingStore = <A, E, R>(
  effect: (
    siblingCalls: Ref.Ref<number>,
  ) => Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  whileDecrypting: (baseDir: string) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-desktop-connection-catalog-test-",
    });
    const siblingCalls = yield* Ref.make(0);
    return yield* effect(siblingCalls).pipe(
      Effect.provide(
        layerFor(baseDir, true, null, NodeServices.layer, siblingCalls, whileDecrypting(baseDir)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("encrypts SSH grant metadata with its bearer and reads it in a fresh store", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const catalog = JSON.stringify({
          ...JSON.parse(VALID_CATALOG),
          credentials: [
            {
              connectionId: "ssh:fixture",
              credential: {
                _tag: "BearerConnectionCredential",
                token: "fixture-bearer",
                sshPairingGrant: {
                  key: "fixture-host-runtime-identity",
                  scopes: ["orchestration:read"],
                },
              },
            },
          ],
        });
        assert.isTrue(yield* store.set(catalog, null));
        const disk = yield* fs.readFileString(`${environment.stateDir}/connection-catalog.json`);
        assert.notInclude(disk, "fixture-host-runtime-identity");
        assert.notInclude(disk, "fixture-bearer");
        assert.notInclude(disk, "sshPairingGrant");
        const restarted = yield* DesktopConnectionCatalogStore.make;
        const loaded = Option.getOrThrow(yield* restarted.get);
        const decoded = yield* decodeConnectionCatalog(loaded);
        assert.deepStrictEqual(decoded.credentials[0]?.credential.sshPairingGrant, {
          key: "fixture-host-runtime-identity",
          scopes: ["orchestration:read"],
        });
      }),
    ),
  );

  it.effect("persists, reads, and clears an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = VALID_CATALOG;

        assert.isTrue(yield* store.set(catalog, null));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));

        yield* store.clear;
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("rejects stale additions and deletions across independent stores", () =>
    withStore(
      Effect.gen(function* () {
        const first = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const second = yield* DesktopConnectionCatalogStore.make;
        const initial = VALID_CATALOG;
        const a = { _tag: "RelayConnectionTarget", environmentId: "A", label: "A" };
        const b = { _tag: "RelayConnectionTarget", environmentId: "B", label: "B" };
        const added = JSON.stringify({ ...JSON.parse(initial), targets: [a] });
        const both = JSON.stringify({ ...JSON.parse(initial), targets: [a, b] });
        const onlyB = JSON.stringify({ ...JSON.parse(initial), targets: [b] });
        assert.isTrue(yield* first.set(initial, null));
        const firstRead = Option.getOrNull(yield* first.get);
        const secondRead = Option.getOrNull(yield* second.get);
        assert.isTrue(yield* first.set(added, firstRead));
        assert.equal(yield* second.set(both, secondRead), "conflict");
        assert.deepStrictEqual(yield* first.get, Option.some(added));
        assert.isTrue(yield* second.set(both, Option.getOrNull(yield* second.get)));
        // A deletes its entry; B's stale save must not resurrect it.
        assert.isTrue(yield* first.set(onlyB, both));
        assert.equal(yield* second.set(added, both), "conflict");
        assert.deepStrictEqual(yield* second.get, Option.some(onlyB));
      }),
    ),
  );

  it.effect("reclaims an expired abandoned lock and releases it after failed saves", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const lockPath = `${environment.stateDir}/connection-catalog.lock`;
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        yield* fs.writeFileString(lockPath, "2147483647:abandoned");
        yield* fs.utimes(lockPath, EXPIRED_LOCK_TIME, EXPIRED_LOCK_TIME);
        assert.isTrue(yield* store.set(VALID_CATALOG, null));
        assert.isFalse(yield* fs.exists(lockPath));
        assert.equal(yield* store.set(VALID_CATALOG, null), "conflict");
        assert.isFalse(yield* fs.exists(lockPath));
        yield* store.clear;
        assert.isFalse(yield* fs.exists(lockPath));
      }),
    ),
  );

  it.effect("reclaims an abandoned expired reclaim guard before saving", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const lockPath = `${environment.stateDir}/connection-catalog.lock`;
        const guardPath = `${lockPath}.reclaim`;
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        yield* fs.writeFileString(lockPath, "2147483647:abandoned");
        yield* fs.writeFileString(guardPath, "2147483647:abandoned-reclaimer");
        yield* fs.utimes(lockPath, EXPIRED_LOCK_TIME, EXPIRED_LOCK_TIME);
        yield* fs.utimes(guardPath, EXPIRED_LOCK_TIME, EXPIRED_LOCK_TIME);

        assert.isTrue(yield* store.set(VALID_CATALOG, null));
        assert.isFalse(yield* fs.exists(lockPath));
        assert.isFalse(yield* fs.exists(guardPath));
        assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
      }),
    ),
  );

  it.effect("respects a fresh reclaim guard over an expired dead-owner lock", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const lockPath = `${environment.stateDir}/connection-catalog.lock`;
        const guardPath = `${lockPath}.reclaim`;
        const owner = "2147483647:abandoned";
        const reclaimer = "2147483647:reclaiming";
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        yield* fs.writeFileString(lockPath, owner);
        yield* fs.writeFileString(guardPath, reclaimer);
        yield* fs.utimes(lockPath, EXPIRED_LOCK_TIME, EXPIRED_LOCK_TIME);
        const lockInfo = yield* fs.stat(lockPath);
        const guardInfo = yield* fs.stat(guardPath);
        const started = yield* Deferred.make<void>();
        const blocked = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeDirectory: () => Effect.void,
            stat: (file) => Effect.succeed(file === guardPath ? guardInfo : lockInfo),
            readFileString: (file) => Effect.succeed(file === guardPath ? reclaimer : owner),
            writeFileString: (file) =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: file,
                }),
              ).pipe(Effect.tapError(() => Deferred.succeed(started, undefined))),
          }),
        );
        const writer = yield* blocked
          .set(VALID_CATALOG, null)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(writer);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.equal(result.failure._tag, "DesktopConnectionCatalogStoreWriteError");
        assert.equal(yield* fs.readFileString(lockPath), owner);
        assert.equal(yield* fs.readFileString(guardPath), reclaimer);
        assert.isFalse(yield* fs.exists(`${environment.stateDir}/connection-catalog.json`));
      }),
    ),
  );

  it.effect.each(["set", "clear"] as const)(
    "holds the cross-store lock between recovery comparison and rename against %s",
    (operation) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-catalog-lock-test-" });
        const reachedWrite = yield* Deferred.make<void>();
        const resumeWrite = yield* Deferred.make<void>();
        const contended = yield* Deferred.make<void>();
        let pause = true;
        const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (file, contents, options) =>
            Effect.gen(function* () {
              if (pause && file.includes("connection-catalog.json.") && file.endsWith(".tmp")) {
                pause = false;
                yield* Deferred.succeed(reachedWrite, undefined);
                yield* Deferred.await(resumeWrite);
              }
              return yield* fs
                .writeFileString(file, contents, options)
                .pipe(
                  Effect.tapError((error) =>
                    file.endsWith("connection-catalog.lock") &&
                    error.reason._tag === "AlreadyExists"
                      ? Deferred.succeed(contended, undefined)
                      : Effect.void,
                  ),
                );
            }),
        });
        yield* Effect.gen(function* () {
          const first = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const second = yield* DesktopConnectionCatalogStore.make;
          const { catalogPath } = yield* writeSiblingCatalog(VALID_CATALOG);
          const recovery = yield* first.get.pipe(Effect.forkChild);
          yield* Deferred.await(reachedWrite);
          const newer = JSON.stringify({
            ...JSON.parse(VALID_CATALOG),
            disabledEnvironmentIds: ["new"],
          });
          const writer = yield* (
            operation === "set" ? second.set(newer, VALID_CATALOG) : second.clear
          ).pipe(Effect.forkChild);
          yield* Deferred.await(contended);
          // Observe the failed exclusive acquisition, cancel its retry, then retry explicitly
          // after recovery. This keeps the ordering independent of OS I/O and timer scheduling.
          yield* Fiber.interrupt(writer);
          yield* Deferred.succeed(resumeWrite, undefined);
          assert.deepStrictEqual(yield* Fiber.join(recovery), Option.some(VALID_CATALOG));
          if (operation === "set") assert.isTrue(yield* second.set(newer, VALID_CATALOG));
          else yield* second.clear;
          if (operation === "set") assert.deepStrictEqual(yield* first.get, Option.some(newer));
          else assert.isFalse(yield* fs.exists(catalogPath));
          assert.isFalse(yield* fs.exists(`${baseDir}/userdata/connection-catalog.lock`));
        }).pipe(Effect.provide(layerFor(baseDir, true, null, fileSystemLayer)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not steal an expired lock from a live owner and bounds lock contention", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const lockPath = `${environment.stateDir}/connection-catalog.lock`;
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        const token = `${process.pid}:live-owner`;
        yield* fs.writeFileString(lockPath, token);
        yield* fs.utimes(lockPath, EXPIRED_LOCK_TIME, EXPIRED_LOCK_TIME);
        const info = yield* fs.stat(lockPath);
        const started = yield* Deferred.make<void>();
        const blocked = yield* DesktopConnectionCatalogStore.make.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            makeDirectory: () => Effect.void,
            stat: () => Effect.succeed(info),
            readFileString: () => Effect.succeed(token),
            writeFileString: () =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "AlreadyExists",
                  module: "FileSystem",
                  method: "writeFileString",
                  pathOrDescriptor: lockPath,
                }),
              ).pipe(Effect.tapError(() => Deferred.succeed(started, undefined))),
          }),
        );
        const writer = yield* blocked
          .set(VALID_CATALOG, null)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(writer);
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result))
          assert.equal(result.failure._tag, "DesktopConnectionCatalogStoreWriteError");
        assert.equal(yield* fs.readFileString(lockPath), token);
        assert.isFalse(yield* fs.exists(`${environment.stateDir}/connection-catalog.json`));
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}", null));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "alex",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isTrue(Option.isSome(migrated));
        if (Option.isNone(migrated)) {
          return;
        }
        const catalog = yield* decodeConnectionCatalog(migrated.value);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "alex",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "goat-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = layerFor(baseDir, true, failDecrypt);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );

      assert.isTrue(yield* store.set(VALID_CATALOG, null));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("recovers a catalog another channel encrypted, backs it up, and re-encrypts it", () =>
    withSiblingStore((siblingCalls) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const { catalogPath, raw, stateDir } = yield* writeSiblingCatalog(VALID_CATALOG);

        assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
        assert.equal(
          yield* fileSystem.readFileString(
            path.join(stateDir, "connection-catalog.goat-nightly.backup.json"),
          ),
          raw,
        );
        const rewritten = JSON.parse(yield* fileSystem.readFileString(catalogPath)) as {
          readonly encryptedCatalog: string;
        };
        assert.equal(
          textDecoder.decode(Base64.decode(rewritten.encryptedCatalog).pipe(Result.getOrThrow)),
          `encrypted:${VALID_CATALOG}`,
        );
        assert.deepStrictEqual(yield* store.unreadable, Option.none());
        // This app's key opens it now, so no further sibling key reads.
        assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
        assert.equal(yield* Ref.get(siblingCalls), 1);
      }),
    ),
  );

  it.effect("keeps an unreadable catalog in place, copies it, and reports where", () =>
    withSiblingStore((siblingCalls) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        // Decrypts, but to something that is not a catalog: a wrong key with lucky padding.
        const { catalogPath, raw, stateDir } = yield* writeSiblingCatalog("not a catalog");
        const backupPath = yield* unreadableBackupPath(stateDir, raw);

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
        );
        assert.equal(yield* fileSystem.readFileString(catalogPath), raw);
        assert.equal(yield* fileSystem.readFileString(backupPath), raw);
        assert.deepStrictEqual(
          yield* store.unreadable,
          Option.some({ catalogPath, backupPath, reason: "locked" as const }),
        );
        // The same file is not retried within a launch, so a refused prompt does not repeat.
        yield* store.get.pipe(Effect.flip);
        assert.equal(yield* Ref.get(siblingCalls), 1);

        // Start fresh saves an empty catalog over it; the copy stays.
        assert.isTrue(yield* store.set(VALID_CATALOG, null));
        assert.equal(yield* fileSystem.readFileString(backupPath), raw);
        assert.deepStrictEqual(yield* store.unreadable, Option.none());
        assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
      }),
    ),
  );

  it.effect("refuses to replace an unreadable catalog it could not copy", () =>
    withSiblingStore(() =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const { catalogPath, raw, stateDir } = yield* writeSiblingCatalog("not a catalog");
        const backupPath = yield* unreadableBackupPath(stateDir, raw);
        // Something else already holds the backup name, so no copy can be made.
        yield* fileSystem.writeFileString(backupPath, "someone else's file");

        yield* store.get.pipe(Effect.flip);
        assert.deepStrictEqual(
          yield* store.unreadable,
          Option.some({ catalogPath, backupPath: null, reason: "locked" as const }),
        );
        const setError = yield* store.set(VALID_CATALOG, null).pipe(Effect.flip);
        assert.instanceOf(
          setError,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
        );
        assert.equal(setError.operation, "back-up-catalog");
        const clearError = yield* store.clear.pipe(Effect.flip);
        assert.equal(clearError.operation, "back-up-catalog");
        assert.equal(yield* fileSystem.readFileString(catalogPath), raw);
        assert.equal(yield* fileSystem.readFileString(backupPath), "someone else's file");
      }),
    ),
  );

  it.effect("asks the sibling key once when the recovered catalog cannot be backed up", () =>
    withSiblingStore((siblingCalls) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const { catalogPath, raw, stateDir } = yield* writeSiblingCatalog(VALID_CATALOG);
        // A non-empty directory holds the backup name, so the copy and re-encryption are skipped.
        const blocker = path.join(stateDir, "connection-catalog.goat-nightly.backup.json");
        yield* fileSystem.makeDirectory(path.join(blocker, "occupied"), { recursive: true });

        assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
        assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
        assert.deepStrictEqual(yield* store.unreadable, Option.none());
        assert.equal(yield* fileSystem.readFileString(catalogPath), raw);
        assert.equal(yield* Ref.get(siblingCalls), 1);
      }),
    ),
  );

  it.effect("copies a catalog it cannot open before a save replaces it, without a prior read", () =>
    withSiblingStore(() =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const { catalogPath, raw, stateDir } = yield* writeSiblingCatalog(VALID_CATALOG);

        assert.isTrue(yield* store.set(VALID_CATALOG, VALID_CATALOG));
        assert.equal(
          yield* fileSystem.readFileString(yield* unreadableBackupPath(stateDir, raw)),
          raw,
        );
        assert.notEqual(yield* fileSystem.readFileString(catalogPath), raw);
      }),
    ),
  );

  it.effect("serves the newer catalog another channel saved during recovery", () => {
    const newerCatalog =
      '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[],"disabledEnvironmentIds":["saved-by-nightly"]}';
    const newerRaw = `${JSON.stringify({
      version: 1,
      encryptedCatalog: Base64.encode(textEncoder.encode(`nightly:${newerCatalog}`)),
    })}\n`;
    let saved = false;
    return withSiblingStore(
      (siblingCalls) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const { catalogPath, stateDir } = yield* writeSiblingCatalog(VALID_CATALOG);

          assert.deepStrictEqual(yield* store.get, Option.some(newerCatalog));
          assert.equal(yield* Ref.get(siblingCalls), 2);
          assert.equal(
            yield* fileSystem.readFileString(
              `${stateDir}/connection-catalog.goat-nightly.backup.json`,
            ),
            newerRaw,
          );
          // Re-encrypted from the newer catalog, never the stale one.
          const rewritten = JSON.parse(yield* fileSystem.readFileString(catalogPath)) as {
            readonly encryptedCatalog: string;
          };
          assert.equal(
            textDecoder.decode(Base64.decode(rewritten.encryptedCatalog).pipe(Result.getOrThrow)),
            `encrypted:${newerCatalog}`,
          );
        }),
      // The other channel saves once, while this one waits on the key prompt.
      (baseDir) =>
        Effect.gen(function* () {
          if (saved) return;
          saved = true;
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(
            `${baseDir}/userdata/connection-catalog.json`,
            newerRaw,
          );
        }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    );
  });

  it.effect("backs up the exact bytes of a catalog that is not valid UTF-8", () =>
    withSiblingStore(() =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        // A BOM, then bytes that are not UTF-8: a text round trip would change both.
        const raw = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0xff, 0xfe, 0x7d]);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFile(catalogPath, raw);
        const digest = yield* crypto.digest("SHA-256", raw);
        const backupPath = path.join(
          environment.stateDir,
          `connection-catalog.unreadable-${Hex.encode(digest).slice(0, 16)}.backup.json`,
        );

        yield* store.get.pipe(Effect.flip);
        assert.deepStrictEqual(yield* fileSystem.readFile(backupPath), raw);
        assert.isTrue(yield* store.set(VALID_CATALOG, null));
        assert.deepStrictEqual(yield* fileSystem.readFile(backupPath), raw);
      }),
    ),
  );

  it.effect(
    "tries sibling keys when this app's key decrypts to something that is not a catalog",
    () =>
      withSiblingStore((siblingCalls) =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
          // This app's key "decrypts" it to garbage with valid padding; the Nightly key fits.
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            catalogPath,
            `${JSON.stringify({
              version: 1,
              encryptedCatalog: Base64.encode(
                textEncoder.encode(`encrypted:nightly:${VALID_CATALOG}`),
              ),
            })}\n`,
          );

          assert.deepStrictEqual(yield* store.get, Option.some(VALID_CATALOG));
          assert.equal(yield* Ref.get(siblingCalls), 1);
        }),
      ),
  );

  it.effect("reports a damaged catalog, keeps it, and copies it", () =>
    withSiblingStore(() =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        // This app's key opens it, but the renderer would discard what is inside.
        assert.isTrue(yield* store.set(VALID_CATALOG, null));
        const raw = `${JSON.stringify({
          version: 1,
          encryptedCatalog: Base64.encode(textEncoder.encode('encrypted:{"schemaVersion":1}')),
        })}\n`;
        yield* fileSystem.writeFileString(catalogPath, raw);
        const backupPath = yield* unreadableBackupPath(environment.stateDir, raw);

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.deepStrictEqual(
          yield* store.unreadable,
          Option.some({ catalogPath, backupPath, reason: "damaged" as const }),
        );
        assert.equal(yield* fileSystem.readFileString(catalogPath), raw);
        assert.equal(yield* fileSystem.readFileString(backupPath), raw);
      }),
    ),
  );
});
