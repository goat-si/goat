import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const {
  decryptStringMock,
  encryptStringMock,
  getSelectedStorageBackendMock,
  isEncryptionAvailableMock,
  safeStorageState,
} = vi.hoisted(() => ({
  decryptStringMock: vi.fn((buffer: Buffer) => {
    const text = buffer.toString("utf8");
    if (!text.startsWith("os-crypt:")) {
      throw new Error("invalid ciphertext");
    }
    return text.slice("os-crypt:".length);
  }),
  encryptStringMock: vi.fn((value: string) => Buffer.from(`os-crypt:${value}`, "utf8")),
  getSelectedStorageBackendMock: vi.fn(() => "gnome_libsecret"),
  isEncryptionAvailableMock: vi.fn(() => false),
  safeStorageState: {
    isPackaged: false,
  },
}));

vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return safeStorageState.isPackaged;
    },
  },
  safeStorage: {
    isEncryptionAvailable: isEncryptionAvailableMock,
    encryptString: encryptStringMock,
    decryptString: decryptStringMock,
    getSelectedStorageBackend: getSelectedStorageBackendMock,
  },
}));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "../app/DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopSafeStorageSiblingKeys from "../app/DesktopSafeStorageSiblingKeys.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const textDecoder = new TextDecoder();
const VALID_CATALOG =
  '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[],"disabledEnvironmentIds":[]}';

const makeDesktopEnvironmentLayer = (input: {
  readonly homeDirectory: string;
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}) =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: input.homeDirectory,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.22",
    appPath: "/repo/apps/desktop",
    isPackaged: input.isPackaged,
    resourcesPath: "/repo/apps/desktop/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(input.env)),
    ),
  );

const makeSafeStorageLayer = (input: {
  readonly homeDirectory: string;
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}) =>
  ElectronSafeStorage.layer.pipe(
    Layer.provideMerge(makeDesktopEnvironmentLayer(input)),
    Layer.provideMerge(NodeServices.layer),
  );

const makeCatalogStoreLayer = (input: {
  readonly homeDirectory: string;
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => {
  const layerEnvAndSafeStorage = makeSafeStorageLayer(input);
  const layerSiblingKeys = Layer.succeed(
    DesktopSafeStorageSiblingKeys.DesktopSafeStorageSiblingKeys,
    {
      decrypt: () => Effect.succeedNone,
    },
  );
  const layerBase = Layer.mergeAll(layerEnvAndSafeStorage, layerSiblingKeys);
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(layerBase));
  return DesktopConnectionCatalogStore.layer.pipe(Layer.provideMerge(layerSavedEnvironments));
};

describe("ElectronSafeStorage", () => {
  beforeEach(() => {
    safeStorageState.isPackaged = false;
    isEncryptionAvailableMock.mockReset();
    isEncryptionAvailableMock.mockReturnValue(false);
    encryptStringMock.mockClear();
    decryptStringMock.mockClear();
    getSelectedStorageBackendMock.mockClear();
  });

  it.effect("ignores GOAT_DEV_INSECURE_SECRET_STORAGE in a packaged build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-safe-storage-pkg-" });
      const homeDirectory = `${tempRoot}/home`;
      const isolatedHome = `${tempRoot}/isolated-goat`;
      safeStorageState.isPackaged = true;

      const layer = makeCatalogStoreLayer({
        homeDirectory,
        isPackaged: true,
        env: {
          GOAT_HOME: isolatedHome,
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
          GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
        },
      });

      const result = yield* Effect.gen(function* () {
        const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
        const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const available = yield* safeStorage.isEncryptionAvailable;
        const saved = yield* catalogStore.set(VALID_CATALOG, null);
        return { available, saved };
      }).pipe(Effect.provide(layer));

      assert.equal(result.available, false);
      assert.equal(result.saved, false);
      assert.equal(encryptStringMock.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ignores GOAT_DEV_INSECURE_SECRET_STORAGE when using a default home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-safe-storage-home-" });
      const homeDirectory = `${tempRoot}/home`;
      yield* fs.makeDirectory(`${homeDirectory}/.goat`, { recursive: true });
      yield* fs.symlink(`${homeDirectory}/.goat`, `${tempRoot}/link-to-goat`);

      for (const goatHome of [
        undefined,
        homeDirectory,
        `${homeDirectory}/.goat`,
        `${homeDirectory}/.t3`,
        `${homeDirectory}/.goat/dev`,
        `${homeDirectory}/.goat/desktop/userdata`,
        `${homeDirectory}/.goat/anything/deeper`,
        `${homeDirectory}/.GOAT`,
        `${homeDirectory}/.T3/dev`,
        `${homeDirectory}/.goat/foo/..`,
        `${tempRoot}/link-to-goat`,
        `${tempRoot}/link-to-goat/dev`,
        ".goat",
        "../isolated",
        "~/.goat",
        "~/.t3",
        "~/isolated",
      ]) {
        const layer = makeCatalogStoreLayer({
          homeDirectory,
          isPackaged: false,
          env: {
            ...(goatHome === undefined ? {} : { GOAT_HOME: goatHome }),
            VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
            GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
          },
        });

        const result = yield* Effect.gen(function* () {
          const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
          const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const available = yield* safeStorage.isEncryptionAvailable;
          const saved = yield* catalogStore.set(VALID_CATALOG, null);
          return { available, saved };
        }).pipe(Effect.provide(layer));

        assert.equal(result.available, false, `GOAT_HOME=${String(goatHome)}`);
        assert.equal(result.saved, false, `GOAT_HOME=${String(goatHome)}`);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never touches the OS keychain when opted in, even if native encryption works", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-safe-storage-native-" });
      // #1298: every read of the keychain item prompts an unsigned dev bundle on macOS.
      isEncryptionAvailableMock.mockReturnValue(true);
      const nativeBlob = Buffer.from("os-crypt:saved-before-opt-in", "utf8");
      const result = yield* Effect.gen(function* () {
        const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
        const available = yield* safeStorage.isEncryptionAvailable;
        const blob = yield* safeStorage.encryptString("secret-token");
        const decrypted = yield* safeStorage.decryptString(blob);
        const nativeError = yield* safeStorage.decryptString(nativeBlob).pipe(Effect.flip);
        return { available, blob, decrypted, nativeError };
      }).pipe(
        Effect.provide(
          makeSafeStorageLayer({
            homeDirectory: `${tempRoot}/home`,
            isPackaged: false,
            env: {
              GOAT_HOME: `${tempRoot}/isolated-goat`,
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
              GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
            },
          }),
        ),
      );
      assert.isTrue(result.available);
      assert.isTrue(textDecoder.decode(result.blob).startsWith("goat-dev-plaintext:v1:"));
      assert.equal(result.decrypted, "secret-token");
      // Ciphertext from before the opt-in stays on disk; reading it needs the flag turned off.
      assert.instanceOf(result.nativeError, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      assert.equal(isEncryptionAvailableMock.mock.calls.length, 0);
      assert.equal(encryptStringMock.mock.calls.length, 0);
      assert.equal(decryptStringMock.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps using the OS keychain without the opt-in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-safe-storage-default-" });
      isEncryptionAvailableMock.mockReturnValue(true);
      const blob = yield* Effect.gen(function* () {
        const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
        return yield* safeStorage.encryptString("secret-token");
      }).pipe(
        Effect.provide(
          makeSafeStorageLayer({
            homeDirectory: `${tempRoot}/home`,
            isPackaged: false,
            env: {
              GOAT_HOME: `${tempRoot}/isolated-goat`,
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
            },
          }),
        ),
      );
      assert.equal(textDecoder.decode(blob), "os-crypt:secret-token");
      assert.equal(encryptStringMock.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("allows saving and round-tripping in dev with an isolated home and opt-in flag", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-safe-storage-dev-" });
      const homeDirectory = `${tempRoot}/home`;
      const isolatedHome = `${tempRoot}/isolated-goat`;
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") {
          warnings.push(message);
        }
      });

      const layer = Layer.mergeAll(
        makeCatalogStoreLayer({
          homeDirectory,
          isPackaged: false,
          env: {
            GOAT_HOME: isolatedHome,
            VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
            GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
          },
        }),
        Logger.layer([logger], { mergeWithExisting: false }),
      );

      const result = yield* Effect.gen(function* () {
        const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
        const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const available = yield* safeStorage.isEncryptionAvailable;
        const blob = yield* safeStorage.encryptString("secret-token");
        const decrypted = yield* safeStorage.decryptString(blob);
        const saved = yield* catalogStore.set(VALID_CATALOG, null);
        const loadedCatalog = yield* catalogStore.get;
        return { available, blob, decrypted, saved, loadedCatalog };
      }).pipe(Effect.provide(layer));

      assert.equal(result.available, true);
      assert.equal(result.decrypted, "secret-token");
      assert.notEqual(textDecoder.decode(result.blob), "secret-token");
      assert.isTrue(textDecoder.decode(result.blob).startsWith("goat-dev-plaintext:v1:"));
      assert.equal(result.saved, true);
      assert.deepEqual(result.loadedCatalog, Option.some(VALID_CATALOG));
      assert.equal(encryptStringMock.mock.calls.length, 0);
      assert.equal(decryptStringMock.mock.calls.length, 0);
      assert.equal(warnings.length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to decrypt a dev-plaintext blob when the fallback is not active", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempRoot = yield* fs.makeTempDirectoryScoped({ prefix: "goat-safe-storage-refuse-" });
      const homeDirectory = `${tempRoot}/home`;
      const isolatedHome = `${tempRoot}/isolated-goat`;

      const devLayer = makeSafeStorageLayer({
        homeDirectory,
        isPackaged: false,
        env: {
          GOAT_HOME: isolatedHome,
          VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
          GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
        },
      });

      const devBlob = yield* Effect.gen(function* () {
        const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
        return yield* safeStorage.encryptString("dev-only-secret");
      }).pipe(Effect.provide(devLayer));

      yield* Effect.gen(function* () {
        const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.equal(yield* catalogStore.set(VALID_CATALOG, null), true);
      }).pipe(
        Effect.provide(
          makeCatalogStoreLayer({
            homeDirectory,
            isPackaged: false,
            env: {
              GOAT_HOME: isolatedHome,
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
              GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
            },
          }),
        ),
      );

      // Even when OS encryption is available, inactive fallback environments must reject dev blobs.
      isEncryptionAvailableMock.mockReturnValue(true);

      for (const inactiveConfig of [
        {
          isPackaged: true,
          env: {
            GOAT_HOME: isolatedHome,
            VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
            GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
          },
        },
        {
          isPackaged: false,
          env: {
            GOAT_HOME: isolatedHome,
            VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
          },
        },
        {
          isPackaged: false,
          env: {
            GOAT_HOME: `${homeDirectory}/.goat`,
            VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
            GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
          },
        },
      ]) {
        const error = yield* Effect.gen(function* () {
          const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
          return yield* safeStorage.decryptString(devBlob).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            makeSafeStorageLayer({
              homeDirectory,
              isPackaged: inactiveConfig.isPackaged,
              env: inactiveConfig.env,
            }),
          ),
        );

        assert.instanceOf(error, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      }

      const catalogError = yield* Effect.gen(function* () {
        const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        return yield* catalogStore.get.pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          makeCatalogStoreLayer({
            homeDirectory,
            isPackaged: true,
            env: {
              GOAT_HOME: isolatedHome,
              VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
              GOAT_DEV_INSECURE_SECRET_STORAGE: "1",
            },
          }),
        ),
      );
      assert.instanceOf(
        catalogError,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );

      assert.equal(decryptStringMock.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
