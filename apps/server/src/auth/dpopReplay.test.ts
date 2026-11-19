import { makeDpopKey } from "./dpop.testkit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { onMainListenerAuth } from "./connectionContext.testkit.ts";

const layerEnvironmentAuth = (overrides: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          return { ...(yield* ServerConfig.ServerConfig), ...overrides };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-auth-replay-test-" })),
      ),
    ),
  );
const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("DPoP HTTP replay", (it) => {
  it.effect("rejects an expired proof on a protected HTTP route", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("20 minutes");
      const auth = onMainListenerAuth(yield* EnvironmentAuth.EnvironmentAuth);
      const key = makeDpopKey();
      const { access_token: token } = yield* auth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const request = {
        method: "GET",
        url: "/api/auth/session",
        cookies: {},
        headers: {
          host: "192.168.1.50:3773",
          authorization: `DPoP ${token}`,
          dpop: key.sign({
            method: "GET",
            url: "http://192.168.1.50:3773/api/auth/session",
            token,
            iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000) - 600,
          }),
        },
      } as never;
      const error = yield* Effect.flip(auth.authenticateHttpRequest(request));
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
      if (error._tag === "ServerAuthInvalidCredentialError")
        expect(error.dpopFailureReason).toBe("time_window");
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );
  it.effect("rejects a replay on a protected HTTP route after token exchange", () =>
    Effect.gen(function* () {
      const serverAuth = onMainListenerAuth(yield* EnvironmentAuth.EnvironmentAuth);
      const key = makeDpopKey();
      const { access_token: token } = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        ["orchestration:read"],
        requestMetadata,
        { proofKeyThumbprint: key.thumbprint },
      );
      const request = {
        method: "GET",
        url: "/api/auth/session",
        cookies: {},
        headers: {
          host: "192.168.1.50:3773",
          authorization: `DPoP ${token}`,
          dpop: key.sign({
            method: "GET",
            url: "http://192.168.1.50:3773/api/auth/session",
            token,
            iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1_000),
          }),
        },
      } as never;
      yield* serverAuth.authenticateHttpRequest(request);
      const error = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
      expect(error._tag).toBe("ServerAuthInvalidCredentialError");
      if (error._tag === "ServerAuthInvalidCredentialError") {
        expect(error.dpopFailureReason).toBe("replay");
      }
    }).pipe(
      Effect.provide(layerEnvironmentAuth({ desktopBootstrapToken: "desktop-bootstrap-token" })),
    ),
  );
});
