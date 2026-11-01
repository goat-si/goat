import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSafeStorageSiblingKeys from "../app/DesktopSafeStorageSiblingKeys.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: "2026-04-09T01:00:00.000Z",
  desktopSsh: {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "alex",
    port: 22,
  },
};

const SavedEnvironmentRegistryDocumentProbe = Schema.Struct({
  version: Schema.Number,
  records: Schema.Array(Schema.Unknown),
});
const SavedEnvironmentRegistryDocumentProbeJson = Schema.fromJsonString(
  SavedEnvironmentRegistryDocumentProbe,
);
const encodeSavedEnvironmentRegistryDocumentProbe = Schema.encodeEffect(
  SavedEnvironmentRegistryDocumentProbeJson,
);

const seedSavedEnvironmentRegistry = Effect.fn(function* (encryptedBearerToken?: string) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
  const encoded = yield* encodeSavedEnvironmentRegistryDocumentProbe({
    version: 1,
    records: [
      {
        ...savedRegistryRecord,
        ...(encryptedBearerToken === undefined ? {} : { encryptedBearerToken }),
      },
    ],
  });
  yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, `${encoded}\n`);
});

function layerSafeStorageFor(input: {
  readonly available: boolean;
  readonly availabilityError?: unknown;
  readonly decryptError?: unknown;
}) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable:
      input.availabilityError === undefined
        ? Effect.succeed(input.available)
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageAvailabilityError({
              cause: input.availabilityError,
            }),
          ),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`enc:${value}`)),
    decryptString: (value) => {
      if (input.decryptError !== undefined) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: input.decryptError,
          }),
        );
      }

      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid secret"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layer(
  baseDir: string,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly decryptError?: unknown;
  },
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
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

  const layerSafeStorage = layerSafeStorageFor({
    available: options?.availableSecretStorage ?? true,
    availabilityError: options?.availabilityError,
    decryptError: options?.decryptError,
  });
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    Layer.succeed(DesktopSafeStorageSiblingKeys.DesktopSafeStorageSiblingKeys, {
      decrypt: (ciphertext, accept) => {
        const decoded = textDecoder.decode(ciphertext);
        const plaintext = decoded.slice("stable:".length);
        return Effect.succeed(
          decoded.startsWith("stable:") && accept(plaintext)
            ? Option.some({ plaintext, runtimeName: "GOAT Alpha" })
            : Option.none(),
        );
      },
    }),
    NodeServices.layer,
    fileSystemLayer,
  );

  return DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(layerDependencies));
}

const withSavedEnvironments = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopSavedEnvironments.DesktopSavedEnvironments>,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly decryptError?: unknown;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "goat-desktop-saved-environments-test-",
    });
    return yield* effect.pipe(Effect.provide(layer(baseDir, options)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopSavedEnvironments", () => {
  it.effect(
    "#1009 recovers copied legacy bearer tokens and re-encrypts with the current channel key",
    () =>
      withSavedEnvironments(
        Effect.gen(function* () {
          const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fs = yield* FileSystem.FileSystem;
          const original = Base64.encode(textEncoder.encode("stable:bearer-token"));
          yield* seedSavedEnvironmentRegistry(original);
          const before = yield* fs.readFileString(environment.savedEnvironmentRegistryPath);
          assert.deepEqual(
            yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
            Option.some("bearer-token"),
          );
          const rewritten = yield* fs.readFileString(environment.savedEnvironmentRegistryPath);
          assert.include(rewritten, Base64.encode(textEncoder.encode("enc:bearer-token")));
          assert.notInclude(rewritten, original);
          assert.notInclude(rewritten, "bearer-token");
          assert.equal(
            yield* fs.readFileString(
              `${environment.savedEnvironmentRegistryPath}.GOAT-Alpha.backup`,
            ),
            before,
          );
          assert.deepEqual(
            yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
            Option.some("bearer-token"),
          );
          assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        }),
      ),
  );

  it.effect("keeps recovered legacy credentials readable when their backup cannot be written", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fs = yield* FileSystem.FileSystem;
        yield* seedSavedEnvironmentRegistry(
          Base64.encode(textEncoder.encode("stable:bearer-token")),
        );
        const before = yield* fs.readFileString(environment.savedEnvironmentRegistryPath);
        yield* fs.makeDirectory(`${environment.savedEnvironmentRegistryPath}.GOAT-Alpha.backup`);
        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
        assert.equal(yield* fs.readFileString(environment.savedEnvironmentRegistryPath), before);
      }),
    ),
  );

  it.effect(
    "rejects sibling plaintext that is not a bearer token without changing the legacy file",
    () =>
      withSavedEnvironments(
        Effect.gen(function* () {
          const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fs = yield* FileSystem.FileSystem;
          yield* seedSavedEnvironmentRegistry(
            Base64.encode(textEncoder.encode("stable:bad token\n")),
          );
          const before = yield* fs.readFileString(environment.savedEnvironmentRegistryPath);
          const error = yield* savedEnvironments
            .getSecret(savedRegistryRecord.environmentId)
            .pipe(Effect.flip);
          assert.equal(error._tag, "DesktopSavedEnvironmentSecretProtectionError");
          assert.equal(yield* fs.readFileString(environment.savedEnvironmentRegistryPath), before);
        }),
      ),
  );

  it.effect("loads lenient saved environment registry documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          `{
            // Same optional envelope shape as browser saved environments.
            "version": 1,
            "records": [
              {
                "environmentId": "${savedRegistryRecord.environmentId}",
                "label": "Remote environment",
                "httpBaseUrl": "https://remote.example.com/",
                "wsBaseUrl": "wss://remote.example.com/",
                "createdAt": "2026-04-09T00:00:00.000Z",
                "lastConnectedAt": "2026-04-09T01:00:00.000Z",
                "desktopSsh": {
                  "alias": "devbox",
                  "hostname": "devbox.example.com",
                  "username": "alex",
                  "port": 22,
                },
              },
            ],
          }\n`,
        );

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
      }),
    ),
  );

  it.effect("reads encrypted saved environment secrets when encryption is available", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* seedSavedEnvironmentRegistry(Base64.encode(textEncoder.encode("enc:bearer-token")));

        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );

  it.effect("returns no secret while encryption is unavailable", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* seedSavedEnvironmentRegistry(Base64.encode(textEncoder.encode("enc:bearer-token")));

        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.none(),
        );
      }),
      { availableSecretStorage: false },
    ),
  );
});
