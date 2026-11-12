import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { PEN_TARGET_ENABLED, PenEnablement } from "./PenEnablement.ts";
import { member, PIN } from "./penDaemon.testkit.ts";
import { PenRuntime } from "./PenRuntime.ts";
import * as PenServer from "./PenServerLayers.ts";

it.layer(NodeServices.layer)("the server's Pen layer", (it) => {
  it.effect("is the build's closed gate: a stored trust root starts nothing", () =>
    Effect.gen(function* () {
      expect(PEN_TARGET_ENABLED).toBe(false);
      expect((yield* PenEnablement).enabled).toBe(false);
      expect(yield* (yield* PenRuntime).status).toEqual({
        state: "off",
        reason: "Pen is not enabled in this build.",
      });
    }).pipe(
      Effect.provide(
        PenServer.layer.pipe(
          Layer.provide(PenServer.layerMainHttpServer),
          Layer.provide(HttpRouter.layer),
          Layer.provide(
            Settings.ServerSettingsService.layerTest({
              pen: {
                executablePath: "/opt/pen/bin/pen",
                stateDir: "/Users/a/.pen",
                meshId: PIN.meshId,
                nodeId: member("q"),
              },
            }),
          ),
          Layer.provide(SessionStore.layer),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(SqlitePersistence.layerMemory),
          Layer.provide(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("pen-server-test")),
            }),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-pen-server-" })),
        ),
      ),
    ),
  );
});
