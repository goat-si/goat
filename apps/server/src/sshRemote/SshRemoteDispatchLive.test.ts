import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as SshConfig from "@goat/ssh/config";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SshRemoteDispatchLive from "./SshRemoteDispatchLive.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const ALIAS = "boat-bx_23456789";

it.effect(
  "regression #863: the runtime's SSH dispatch sees this server's cloud machines before their SSH entry exists",
  () =>
    Effect.gen(function* () {
      const discoverHosts = vi
        .spyOn(SshConfig, "discoverSshHosts")
        .mockReturnValue(Effect.succeed([]));
      const managerLayer = vi
        .spyOn(SshTunnel.SshEnvironmentManager, "layer")
        .mockReturnValue(Layer.mock(SshTunnel.SshEnvironmentManager)({}));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          managerLayer.mockRestore();
          discoverHosts.mockRestore();
        }),
      );
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(config.stateDir, "cloud-machines.json"),
          JSON.stringify({
            version: 1,
            machines: [
              {
                sandboxId: "bx_23456789",
                alias: ALIAS,
                label: "test",
                type: "small",
                ttlSeconds: 3600,
                deletePending: false,
              },
            ],
            pendingCreates: [],
          }),
        );
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;

        expect(yield* dispatch.listHosts({ probe: false })).toEqual([
          { alias: ALIAS, source: "cloud-machine" },
        ]);
        // Owned, so browsing goes to Boat readiness (no key here) instead of host_unknown.
        const browsed = yield* dispatch.browse({ host: ALIAS }).pipe(Effect.flip);
        expect(browsed.reason).toBe("host_unavailable");
      }).pipe(
        Effect.provide(
          SshRemoteDispatchLive.layer.pipe(
            Layer.provideMerge(
              ServerSettings.layerTest({ goatclaw: { enabled: false, defaultProfile: "worker" } }),
            ),
            Layer.provideMerge(Sqlite.layerMemory),
            Layer.provideMerge(
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () => Effect.succeed(Option.none()),
              }),
            ),
            Layer.provideMerge(ProcessRunner.layer),
            Layer.provideMerge(
              ServerConfig.layerTest("/fixture", { prefix: "goat-ssh-composition-test-" }),
            ),
            Layer.provideMerge(FetchHttpClient.layer),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
