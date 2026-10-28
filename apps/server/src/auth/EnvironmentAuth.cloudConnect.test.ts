import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
const layerServerConfig = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides, port: 13773 };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest("/", { prefix: "connect-cloud-grants-" })));
const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "GOAT",
  ipAddress: "127.0.0.1",
};
const makeDiskEnvironmentAuthLayer = Effect.fn("makeDiskEnvironmentAuthLayer")(function* (
  baseDir: string,
) {
  const devUrl = new URL("http://127.0.0.1:5173");
  const paths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  yield* ServerConfig.ensureServerDirectories(paths);
  return EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerFromPath(paths.dbPath)),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig({ ...paths, baseDir, mode: "web", devUrl })),
  );
});

it.effect(
  "pending ordinary cloud grants persist across restart and are denied after withdrawal or relink",
  () =>
    Effect.gen(function* () {
      const baseDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "goat-cloud-grants-",
      });
      const before = yield* makeDiskEnvironmentAuthLayer(baseDir);
      const after = yield* makeDiskEnvironmentAuthLayer(baseDir);
      const credentials = yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const legacy = yield* auth.createPairingLink({
          subject: "cloud-connect",
          scopes: ["terminal:read"],
        });
        yield* auth.setCloudLinkTrust("account");
        const valid = yield* auth.createPairingLink({
          subject: "cloud-connect",
          scopes: ["terminal:read"],
        });
        const withdrawn = yield* auth.createPairingLink({
          subject: "cloud-connect",
          scopes: ["terminal:read"],
        });
        return { legacy, valid, withdrawn };
      }).pipe(Effect.provide(before), Effect.scoped);
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const exchange = (credential: string) =>
          auth.exchangeBootstrapCredentialForAccessToken(
            credential,
            ["terminal:read"],
            requestMetadata,
          );
        expect((yield* exchange(credentials.legacy.credential).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* exchange(credentials.valid.credential)).scope).toBe("terminal:read");
        yield* auth.setCloudLinkTrust(null);
        yield* auth.setCloudLinkTrust("account");
        expect((yield* exchange(credentials.withdrawn.credential).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }).pipe(Effect.provide(after), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
